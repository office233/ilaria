package cortex

// transformer_backward.go — Full backpropagation for MiniTransformer.
//
// The original TrainStep in transformer.go only updated token embeddings
// from the LM-head gradient and perturbed block weights with Gaussian
// noise; transformer blocks therefore could not learn. This file adds
// the missing pieces:
//
//   - LayerNormFwd: forward variant that returns the per-row mean and
//     inverse stddev needed by the backward pass.
//   - layerNormBackward / matMulBackward / matMulTBackward / softmaxBackward
//     / geluBackward: low-level gradient helpers.
//   - MultiHeadAttention.Backward / FeedForward.Backward /
//     TransformerBlock.Backward: module-level backward passes that
//     accumulate parameter gradients and return the gradient w.r.t. their
//     input.
//   - MiniTransformer.TrainStepBackprop: replacement for TrainStep that
//     actually propagates the loss all the way back through every layer.
//
// All weight updates remain plain SGD with the supplied learning rate;
// optimizer-specific logic (Adam, schedules) lives in
// transformer_optimizer.go.

import (
	"math"
)

// ─────────────────────────────────────────────────────────────────────
// LayerNorm forward with cached statistics
// ─────────────────────────────────────────────────────────────────────

// layerNormEps mirrors the constant inside Tensor.LayerNorm. Kept
// private to backward so we never disagree on the value used during
// forward and gradient computations.
const layerNormEps float32 = 1e-5

// LayerNormFwd is the training-time forward pass for LayerNorm.
// It computes the same output as Tensor.LayerNorm but also returns
// per-row mean and inverse stddev, both length M (one per row), so the
// backward pass can avoid recomputing them.
func LayerNormFwd(x, gamma, beta *Tensor) (out *Tensor, mean, invStd []float32) {
	M, N := x.Shape[0], x.Shape[1]
	out = NewTensor(M, N)
	mean = make([]float32, M)
	invStd = make([]float32, M)
	for i := 0; i < M; i++ {
		off := i * N
		// Mean
		var mu float32
		for j := 0; j < N; j++ {
			mu += x.Data[off+j]
		}
		mu /= float32(N)
		// Variance
		var v float32
		for j := 0; j < N; j++ {
			d := x.Data[off+j] - mu
			v += d * d
		}
		v /= float32(N)
		inv := float32(1.0 / math.Sqrt(float64(v+layerNormEps)))
		mean[i] = mu
		invStd[i] = inv
		for j := 0; j < N; j++ {
			normalized := (x.Data[off+j] - mu) * inv
			out.Data[off+j] = gamma.Data[j]*normalized + beta.Data[j]
		}
	}
	return out, mean, invStd
}

// layerNormBackward computes the gradient of LayerNorm w.r.t. its input,
// scale (gamma) and shift (beta).
//
// Given y_i = gamma * (x_i - mu) / sigma + beta with mu and sigma the
// per-row statistics, the standard result is:
//
//	dxhat_i = dy_i * gamma
//	dx_i = (1/N) * invStd * (N*dxhat_i - sum(dxhat) - xhat_i * sum(dxhat * xhat))
//	dGamma += dy_i * xhat_i      (summed across rows)
//	dBeta  += dy_i               (summed across rows)
//
// Inputs:
//
//	dOut       gradient flowing into LayerNorm output, [M, N]
//	x          original input to LayerNorm, [M, N]
//	gamma      scale parameter, [N]
//	mean       per-row mean from forward, length M
//	invStd     per-row inverse stddev from forward, length M
//	dGammaAcc  accumulator for gamma gradient, [N]
//	dBetaAcc   accumulator for beta gradient, [N]
//
// Returns dX [M, N].
func layerNormBackward(dOut, x, gamma *Tensor, mean, invStd []float32,
	dGammaAcc, dBetaAcc *Tensor) *Tensor {
	M, N := x.Shape[0], x.Shape[1]
	dX := NewTensor(M, N)
	invN := float32(1.0 / float64(N))

	for i := 0; i < M; i++ {
		off := i * N
		mu := mean[i]
		inv := invStd[i]

		var sumDxhat, sumDxhatXhat float32
		for j := 0; j < N; j++ {
			xhat := (x.Data[off+j] - mu) * inv
			dY := dOut.Data[off+j]
			// Param grads: accumulate across all rows.
			dGammaAcc.Data[j] += dY * xhat
			dBetaAcc.Data[j] += dY
			dxhat := dY * gamma.Data[j]
			sumDxhat += dxhat
			sumDxhatXhat += dxhat * xhat
		}
		for j := 0; j < N; j++ {
			xhat := (x.Data[off+j] - mu) * inv
			dY := dOut.Data[off+j]
			dxhat := dY * gamma.Data[j]
			dX.Data[off+j] = invN * inv * (float32(N)*dxhat - sumDxhat - xhat*sumDxhatXhat)
		}
	}
	return dX
}

// ─────────────────────────────────────────────────────────────────────
// MatMul gradients
// ─────────────────────────────────────────────────────────────────────

// matMulBackward returns gradients for C = A · B given dC.
//
//	dA = dC · B^T
//	dB = A^T · dC
func matMulBackward(dC, A, B *Tensor) (dA, dB *Tensor) {
	dA = dC.MatMulTransposed(B) // dC [M,N] × B^T [N,K] → [M,K]
	dB = A.Transpose().MatMul(dC)
	return dA, dB
}

// addBiasBackward returns the gradient for a bias vector that was
// broadcast-added to each row of a [M, N] tensor. The bias grad is the
// column sum of dOut.
func addBiasBackward(dOut *Tensor) *Tensor {
	M, N := dOut.Shape[0], dOut.Shape[1]
	db := NewTensor(N)
	for i := 0; i < M; i++ {
		off := i * N
		for j := 0; j < N; j++ {
			db.Data[j] += dOut.Data[off+j]
		}
	}
	return db
}

// ─────────────────────────────────────────────────────────────────────
// Activation gradients
// ─────────────────────────────────────────────────────────────────────

// geluBackward returns dX given dOut and the original GELU input x,
// using the tanh approximation that Tensor.GELU implements.
//
// GELU(x) = 0.5 * x * (1 + tanh(c * (x + 0.044715 * x^3))) where
// c = sqrt(2/pi). Its derivative is:
//
//	t  = tanh(c * (x + 0.044715 x^3))
//	dt = (1 - t^2) * c * (1 + 3 * 0.044715 * x^2)
//	d/dx GELU(x) = 0.5 * (1 + t) + 0.5 * x * dt
func geluBackward(dOut, x *Tensor) *Tensor {
	dX := NewTensor(x.Shape...)
	c := float32(math.Sqrt(2.0 / math.Pi))
	for i, xi := range x.Data {
		inner := c * (xi + 0.044715*xi*xi*xi)
		th := float32(math.Tanh(float64(inner)))
		dInner := c * (1 + 3*0.044715*xi*xi)
		dGELU := 0.5*(1+th) + 0.5*xi*(1-th*th)*dInner
		dX.Data[i] = dOut.Data[i] * dGELU
	}
	return dX
}

// softmaxBackwardRow computes dX for one row of softmax given dOut and
// the softmax output y for that row. The Jacobian product simplifies to
//
//	dX_i = y_i * (dOut_i - sum_j(dOut_j * y_j))
//
// This is the standard identity that avoids materialising the full
// Jacobian; both inputs and outputs are length N.
func softmaxBackwardRow(dOut, y []float32) []float32 {
	N := len(y)
	dX := make([]float32, N)
	var dot float32
	for i := 0; i < N; i++ {
		dot += dOut[i] * y[i]
	}
	for i := 0; i < N; i++ {
		dX[i] = y[i] * (dOut[i] - dot)
	}
	return dX
}

// ─────────────────────────────────────────────────────────────────────
// FeedForward backward
// ─────────────────────────────────────────────────────────────────────

// Backward propagates dOut (shape [seqLen, embedDim]) back through
//
//	output = GELU(x · W1 + B1) · W2 + B2
//
// accumulating gradients into W1Grad/B1Grad/W2Grad/B2Grad and returning
// dX (the gradient w.r.t. the input x).
func (ff *FeedForward) Backward(dOut *Tensor) *Tensor {
	x := ff.lastInput
	hidden := ff.lastHidden // pre-GELU
	act := ff.lastAct       // post-GELU

	// Layer 2: out = act · W2 + B2
	// act here is the POST-dropout activation (see Forward), so dW2 is
	// exact and dAct is the gradient w.r.t. the thinned values.
	dAct, dW2 := matMulBackward(dOut, act, ff.W2)
	dB2 := addBiasBackward(dOut)
	ff.W2Grad.AddInPlace(dW2)
	ff.B2Grad.AddInPlace(dB2)

	// Undo dropout for the upstream gradient: the mask holds 0 or
	// 1/(1-p), exactly the chain-rule factor of the thinning op.
	if ff.lastDropMask != nil {
		for i := range dAct.Data {
			dAct.Data[i] *= ff.lastDropMask.Data[i]
		}
	}

	if ff.useSwiGLU {
		// act = SiLU(h1) ⊙ g — differentiate each factor by the other.
		silu := ff.lastSiLU
		gate := ff.lastGate

		dH1 := NewTensor(hidden.Shape...) // via SiLU'(h1)
		dGate := NewTensor(gate.Shape...)
		for i := range dAct.Data {
			d := dAct.Data[i]
			dGate.Data[i] = d * silu.Data[i]
			// SiLU'(x) = σ(x)·(1 + x·(1−σ(x))), with σ recovered from the
			// cached SiLU value where possible is fiddly — recompute σ.
			sig := 1 / (1 + float32(math.Exp(float64(-hidden.Data[i]))))
			dH1.Data[i] = d * gate.Data[i] * sig * (1 + hidden.Data[i]*(1-sig))
		}

		dX1, dW1 := matMulBackward(dH1, x, ff.W1)
		dB1 := addBiasBackward(dH1)
		ff.W1Grad.AddInPlace(dW1)
		ff.B1Grad.AddInPlace(dB1)

		dX3, dW3 := matMulBackward(dGate, x, ff.W3)
		dB3 := addBiasBackward(dGate)
		ff.W3Grad.AddInPlace(dW3)
		ff.B3Grad.AddInPlace(dB3)

		dX1.AddInPlace(dX3)
		return dX1
	}

	// GELU: dHidden = dAct * GELU'(hidden)
	dHidden := geluBackward(dAct, hidden)

	// Layer 1: hidden = x · W1 + B1
	dX, dW1 := matMulBackward(dHidden, x, ff.W1)
	dB1 := addBiasBackward(dHidden)
	ff.W1Grad.AddInPlace(dW1)
	ff.B1Grad.AddInPlace(dB1)

	return dX
}

// ─────────────────────────────────────────────────────────────────────
// MultiHeadAttention backward
// ─────────────────────────────────────────────────────────────────────

// Backward propagates dOut (shape [seqLen, embedDim]) back through the
// causal multi-head self-attention, accumulating gradients into all the
// projection weight buffers (WQ/WK/WV/WO and their biases) and returning
// dX (gradient w.r.t. the input).
//
// Forward recap:
//
//	Q = x·WQ + BQ, K = x·WK + BK, V = x·WV + BV
//	for each head h:
//	    Qh, Kh, Vh = head slices
//	    scores_h = Qh · Kh^T / sqrt(headDim) with causal mask
//	    weights_h = softmax(scores_h)
//	    headOut_h = weights_h · Vh
//	attnOut = concat(headOut_h)
//	output = attnOut · WO + BO
func (mha *MultiHeadAttention) Backward(dOut *Tensor) *Tensor {
	x := mha.lastInput
	Q := mha.lastQ
	K := mha.lastK
	V := mha.lastV
	attnOut := mha.lastAttnOut
	allWeights := mha.lastAttnWeights // [numHeads, seqLen, seqLen]

	seqLen := x.Shape[0]
	embedDim := x.Shape[1]
	numHeads := mha.NumHeads
	headDim := mha.HeadDim
	scale := float32(1.0 / math.Sqrt(float64(headDim)))

	// Output projection: output = attnOut · WO + BO
	dAttnOut, dWO := matMulBackward(dOut, attnOut, mha.WO)
	dBO := addBiasBackward(dOut)
	mha.WOGrad.AddInPlace(dWO)
	mha.BOGrad.AddInPlace(dBO)

	// Accumulators for dQ, dK, dV with shape [seqLen, embedDim].
	dQ := NewTensor(seqLen, embedDim)
	dK := NewTensor(seqLen, embedDim)
	dV := NewTensor(seqLen, embedDim)

	for h := 0; h < numHeads; h++ {
		hStart := h * headDim

		// Reconstruct per-head Q, K, V and weights for this head.
		Qh := NewTensor(seqLen, headDim)
		Kh := NewTensor(seqLen, headDim)
		Vh := NewTensor(seqLen, headDim)
		dHeadOut := NewTensor(seqLen, headDim)
		for i := 0; i < seqLen; i++ {
			for j := 0; j < headDim; j++ {
				Qh.Data[i*headDim+j] = Q.Data[i*embedDim+hStart+j]
				Kh.Data[i*headDim+j] = K.Data[i*embedDim+hStart+j]
				Vh.Data[i*headDim+j] = V.Data[i*embedDim+hStart+j]
				dHeadOut.Data[i*headDim+j] = dAttnOut.Data[i*embedDim+hStart+j]
			}
		}
		// weights = PRE-dropout softmax output (what Forward cached).
		weights := NewTensor(seqLen, seqLen)
		copy(weights.Data, allWeights.Data[h*seqLen*seqLen:(h+1)*seqLen*seqLen])

		// The forward product actually used the THINNED weights
		// D(W) = W ⊙ mask, so both dVh and the incoming dWeights live
		// on that thinned path; the mask re-enters the chain rule in
		// two places below. droppedWeights == weights when mask is nil.
		droppedWeights := weights
		var headMask []float32
		if mha.lastDropMask != nil {
			headMask = mha.lastDropMask.Data[h*seqLen*seqLen : (h+1)*seqLen*seqLen]
			droppedWeights = NewTensor(seqLen, seqLen)
			for i := range weights.Data {
				droppedWeights.Data[i] = weights.Data[i] * headMask[i]
			}
		}

		// headOut = D(W) · Vh
		// dD(W) = dHeadOut · Vh^T   shape [seqLen, seqLen]
		// dVh   = D(W)^T · dHeadOut  shape [seqLen, headDim]
		dWeights, dVhFromOut := matMulBackward(dHeadOut, droppedWeights, Vh)
		_ = dVhFromOut

		// Re-derive dVh via the cleaner formula D(W)^T · dHeadOut so
		// numbers match the canonical attention backward derivation; the
		// matMulBackward result above is equivalent up to ordering but
		// rewriting it makes the data flow obvious.
		WT := droppedWeights.Transpose()
		dVh := WT.MatMul(dHeadOut)

		// Chain rule through the thinning: dW = dD(W) ⊙ mask.
		if headMask != nil {
			for i := range dWeights.Data {
				dWeights.Data[i] *= headMask[i]
			}
		}

		// Softmax backward per row, on the PRE-dropout weights (softmax's
		// own output). The causal mask zeros the upper triangle of
		// weights, and softmaxBackwardRow naturally produces zero dX
		// where y is zero, so that mask carries through without extra
		// bookkeeping.
		dScores := NewTensor(seqLen, seqLen)
		for i := 0; i < seqLen; i++ {
			dRow := softmaxBackwardRow(
				dWeights.Data[i*seqLen:(i+1)*seqLen],
				weights.Data[i*seqLen:(i+1)*seqLen],
			)
			copy(dScores.Data[i*seqLen:], dRow)
		}

		// Re-apply causal mask on dScores (positions j>i had weight 0
		// after softmax over -inf scores; their gradient is also 0).
		for i := 0; i < seqLen; i++ {
			for j := i + 1; j < seqLen; j++ {
				dScores.Data[i*seqLen+j] = 0
			}
		}

		// scores = Qh · Kh^T * scale
		// dQh = dScores · Kh * scale
		// dKh = dScores^T · Qh * scale
		dQh := dScores.MatMul(Kh).Scale(scale)
		dKh := dScores.Transpose().MatMul(Qh).Scale(scale)

		// Scatter per-head grads back into dQ, dK, dV.
		for i := 0; i < seqLen; i++ {
			for j := 0; j < headDim; j++ {
				dQ.Data[i*embedDim+hStart+j] += dQh.Data[i*headDim+j]
				dK.Data[i*embedDim+hStart+j] += dKh.Data[i*headDim+j]
				dV.Data[i*embedDim+hStart+j] += dVh.Data[i*headDim+j]
			}
		}
	}

	// RoPE backward: dQ/dK above are gradients w.r.t. the ROTATED
	// projections. The rotation is orthogonal, so its backward is the
	// inverse rotation — applied before the projection-weight gradients
	// AND the bias gradients (the bias is added pre-rotation in Forward).
	if mha.useRoPE {
		applyRoPE(dQ, numHeads, headDim, 0, true)
		applyRoPE(dK, numHeads, headDim, 0, true)
	}

	// Q = x · WQ + BQ  →  dX_Q = dQ · WQ^T,  dWQ = x^T · dQ
	dXq, dWQ := matMulBackward(dQ, x, mha.WQ)
	dXk, dWK := matMulBackward(dK, x, mha.WK)
	dXv, dWV := matMulBackward(dV, x, mha.WV)
	dBQ := addBiasBackward(dQ)
	dBK := addBiasBackward(dK)
	dBV := addBiasBackward(dV)
	mha.WQGrad.AddInPlace(dWQ)
	mha.WKGrad.AddInPlace(dWK)
	mha.WVGrad.AddInPlace(dWV)
	mha.BQGrad.AddInPlace(dBQ)
	mha.BKGrad.AddInPlace(dBK)
	mha.BVGrad.AddInPlace(dBV)

	// Total dX from the three projections.
	dX := NewTensor(seqLen, embedDim)
	for i := range dX.Data {
		dX.Data[i] = dXq.Data[i] + dXk.Data[i] + dXv.Data[i]
	}
	return dX
}

// ─────────────────────────────────────────────────────────────────────
// TransformerBlock backward
// ─────────────────────────────────────────────────────────────────────

// Backward propagates dOut through the pre-norm transformer block.
// Forward (recap):
//
//	normed1 = LN1(x)
//	resid1  = x + Attn(normed1)
//	normed2 = LN2(resid1)
//	out     = resid1 + FFN(normed2)
func (tb *TransformerBlock) Backward(dOut *Tensor) *Tensor {
	// out = resid1 + FFN(normed2)  →  dResid1 += dOut, dFFNOut = dOut
	dResid1 := dOut.Clone()

	// FFN backward → dNormed2
	dNormed2 := tb.FFN.Backward(dOut)

	// LN2 backward (over resid1) → dResid1Add
	dResid1Add := layerNormBackward(dNormed2, tb.lastResid1, tb.LN2Gamma,
		tb.ln2Mean, tb.ln2InvStd, tb.LN2GammaGrad, tb.LN2BetaGrad)
	dResid1.AddInPlace(dResid1Add)

	// resid1 = x + Attn(normed1)  →  dX += dResid1, dAttnOut = dResid1
	dX := dResid1.Clone()

	// Attn backward → dNormed1
	dNormed1 := tb.Attn.Backward(dResid1)

	// LN1 backward (over x) → dXAdd
	dXAdd := layerNormBackward(dNormed1, tb.lastInput, tb.LN1Gamma,
		tb.ln1Mean, tb.ln1InvStd, tb.LN1GammaGrad, tb.LN1BetaGrad)
	dX.AddInPlace(dXAdd)

	return dX
}

// ─────────────────────────────────────────────────────────────────────
// Training-time forward + full backprop step
// ─────────────────────────────────────────────────────────────────────

// ForwardTrain is the same as Forward but populates the LayerNorm
// statistics caches that Backward depends on, and arms dropout for the
// duration of the pass. Inference paths (Forward/GenerateFast) skip
// both: no backward caches, no stochastic thinning.
func (m *MiniTransformer) ForwardTrain(tokenIDs []int) *Tensor {
	m.setDropoutActive(true)
	defer m.setDropoutActive(false)

	x := m.Embedding.Forward(tokenIDs)

	for _, b := range m.Blocks {
		b.lastInput = x

		// Pre-norm attention
		normed1, mu1, inv1 := LayerNormFwd(x, b.LN1Gamma, b.LN1Beta)
		b.lastNormed1 = normed1
		b.ln1Mean = mu1
		b.ln1InvStd = inv1

		attnOut := b.Attn.Forward(normed1)
		resid1 := x.Add(attnOut)
		b.lastResid1 = resid1

		// Pre-norm FFN
		normed2, mu2, inv2 := LayerNormFwd(resid1, b.LN2Gamma, b.LN2Beta)
		b.lastNormed2 = normed2
		b.ln2Mean = mu2
		b.ln2InvStd = inv2

		ffnOut := b.FFN.Forward(normed2)
		x = resid1.Add(ffnOut)
	}

	m.lastPreLNF = x
	xn, mu, inv := LayerNormFwd(x, m.LNFGamma, m.LNFBeta)
	m.lnfMean = mu
	m.lnfInvStd = inv
	m.lastHiddenState = xn

	logits := xn.MatMulTransposed(m.Embedding.TokenEmb)
	return logits
}

// TrainStepBackprop performs the actual forward + full backward + SGD
// update step. Unlike the original simplified TrainStep (which only
// updates token embeddings and perturbs block weights with noise), this
// flows true gradients through every layer, so the transformer can
// converge on real data.
//
// Returns the per-token cross-entropy loss for this sequence.
func (m *MiniTransformer) TrainStepBackprop(tokenIDs []int, lr float32) float32 {
	if len(tokenIDs) < 2 {
		return 0
	}
	seqLen := len(tokenIDs) - 1
	if seqLen > m.Config.MaxSeqLen {
		seqLen = m.Config.MaxSeqLen
	}
	input := tokenIDs[:seqLen]
	target := tokenIDs[1 : seqLen+1]

	// Zero all gradients before accumulating.
	m.Embedding.ZeroGrad()
	for _, b := range m.Blocks {
		b.ZeroGrad()
	}
	m.LNFGammaGrad.Zeros()
	m.LNFBetaGrad.Zeros()

	logits := m.ForwardTrain(input)
	loss := CrossEntropyLoss(logits, target)
	dLogits := CrossEntropySoftmaxGrad(logits, target)

	// LM head (tied weights):
	//   logits = hidden · TokenEmb^T
	// → dHidden  = dLogits · TokenEmb
	// → dTokenEmb += dLogits^T · hidden
	hidden := m.lastHiddenState
	dHidden := dLogits.MatMul(m.Embedding.TokenEmb)
	dTokenEmbFromHead := dLogits.Transpose().MatMul(hidden)
	m.Embedding.TokenEmbGrad.AddInPlace(dTokenEmbFromHead)

	// Final LayerNorm backward → dPreLNF
	dPreLNF := layerNormBackward(dHidden, m.lastPreLNF, m.LNFGamma,
		m.lnfMean, m.lnfInvStd, m.LNFGammaGrad, m.LNFBetaGrad)

	// Propagate through transformer blocks in reverse order.
	dX := dPreLNF
	for i := len(m.Blocks) - 1; i >= 0; i-- {
		dX = m.Blocks[i].Backward(dX)
	}

	// Embedding lookup backward — adds the extra TokenEmb grad coming
	// down from the network plus the PosEmb grad.
	m.Embedding.Backward(dX, input)

	// Plain SGD update. Adam/scheduler live in transformer_optimizer.go.
	sgdUpdate(m, lr)

	return loss
}

// sgdUpdate applies plain SGD to every trainable parameter in the
// transformer. Kept in this file so TrainStepBackprop is self-contained;
// the optimizer module wraps this with Adam state when requested.
func sgdUpdate(m *MiniTransformer, lr float32) {
	// Embedding
	m.Embedding.Update(lr)

	// Final LN
	for j := range m.LNFGamma.Data {
		m.LNFGamma.Data[j] -= lr * m.LNFGammaGrad.Data[j]
		m.LNFBeta.Data[j] -= lr * m.LNFBetaGrad.Data[j]
	}

	for _, b := range m.Blocks {
		// LN1 / LN2
		for j := range b.LN1Gamma.Data {
			b.LN1Gamma.Data[j] -= lr * b.LN1GammaGrad.Data[j]
			b.LN1Beta.Data[j] -= lr * b.LN1BetaGrad.Data[j]
			b.LN2Gamma.Data[j] -= lr * b.LN2GammaGrad.Data[j]
			b.LN2Beta.Data[j] -= lr * b.LN2BetaGrad.Data[j]
		}
		// Attention
		sgdTensor(b.Attn.WQ, b.Attn.WQGrad, lr)
		sgdTensor(b.Attn.WK, b.Attn.WKGrad, lr)
		sgdTensor(b.Attn.WV, b.Attn.WVGrad, lr)
		sgdTensor(b.Attn.WO, b.Attn.WOGrad, lr)
		sgdTensor(b.Attn.BQ, b.Attn.BQGrad, lr)
		sgdTensor(b.Attn.BK, b.Attn.BKGrad, lr)
		sgdTensor(b.Attn.BV, b.Attn.BVGrad, lr)
		sgdTensor(b.Attn.BO, b.Attn.BOGrad, lr)
		// FFN
		sgdTensor(b.FFN.W1, b.FFN.W1Grad, lr)
		sgdTensor(b.FFN.W2, b.FFN.W2Grad, lr)
		sgdTensor(b.FFN.B1, b.FFN.B1Grad, lr)
		sgdTensor(b.FFN.B2, b.FFN.B2Grad, lr)
	}
}

func sgdTensor(w, g *Tensor, lr float32) {
	for i := range w.Data {
		w.Data[i] -= lr * g.Data[i]
	}
}
