//go:build gpu

package cortex

import "ilaria/cortex/compute"

const bitnetLoRACUDASource = `
extern "C" __global__ void lora_matvec(const float* w, const float* x,
    int cols, float scale, int add, float* y) {
    int row = blockIdx.x;
    __shared__ float partial[128];
    float sum = 0;
    for (int i=threadIdx.x; i<cols; i+=blockDim.x) sum += w[row*cols+i]*x[i];
    partial[threadIdx.x] = sum;
    __syncthreads();
    for (int stride=64; stride>0; stride>>=1) {
        if (threadIdx.x<stride) partial[threadIdx.x] += partial[threadIdx.x+stride];
        __syncthreads();
    }
    if (threadIdx.x==0) {
        float value = scale*partial[0];
        if (add) y[row] += value; else y[row] = value;
    }
}
`

type cudaLoRA struct {
	a, b, tmp     *compute.DeviceBuffer
	in, out, rank int32
	scale         float32
}

func (a *cudaLoRA) close() { a.a.Free(); a.b.Free(); a.tmp.Free() }
func uploadCUDALoRA(l *BitLinear) (_ *cudaLoRA, err error) {
	a := &cudaLoRA{in: int32(l.In), out: int32(l.Out), rank: int32(l.lora.Rank), scale: l.lora.Scale}
	defer func() {
		if err != nil {
			a.close()
		}
	}()
	if a.a, err = uploadFloat32(l.lora.A); err != nil {
		return nil, err
	}
	if a.b, err = uploadFloat32(l.lora.B); err != nil {
		return nil, err
	}
	if a.tmp, err = compute.AllocDevice(l.lora.Rank * 4); err != nil {
		return nil, err
	}
	return a, nil
}
func (d *BitNetCUDADecoder) addCUDALoRA(tiles, y *compute.DeviceBuffer, offset int) error {
	a := d.loraWeights[tiles]
	if a == nil {
		return nil
	}
	args := compute.NewKernelArgs().AddDevicePtr(a.a).AddDevicePtr(d.loraInput).AddInt32(a.in).AddFloat32(1).AddInt32(0).AddDevicePtr(a.tmp)
	defer args.Release()
	if err := d.mod.Launch("lora_matvec", [3]uint32{uint32(a.rank), 1, 1}, [3]uint32{128, 1, 1}, 0, args); err != nil {
		return err
	}
	out := compute.NewKernelArgs().AddDevicePtr(a.b).AddDevicePtr(a.tmp).AddInt32(a.rank).AddFloat32(a.scale).AddInt32(1).AddDevicePtrOffset(y, offset)
	defer out.Release()
	return d.mod.Launch("lora_matvec", [3]uint32{uint32(a.out), 1, 1}, [3]uint32{128, 1, 1}, 0, out)
}
