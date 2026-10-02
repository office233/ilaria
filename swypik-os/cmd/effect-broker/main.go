// effect-broker is a local JSONL adapter. Its host configuration supplies all
// authority; stdin contains only effect requests and never credentials/grants.
package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"swypik-os/core/controlkernel"
	"swypik-os/core/effects"
	wire "swypik-os/generated/swypeffects"
)

type hostGrant struct {
	GrantID         string `json:"grant_id"`
	RequestHash     string `json:"request_hash"`
	RequestID       string `json:"request_id"`
	Effect          string `json:"effect"`
	Capability      string `json:"capability"`
	TaskID          string `json:"task_id"`
	NodeID          string `json:"node_id"`
	RootID          string `json:"root_id"`
	MaxBytes        int64  `json:"max_bytes"`
	ExpiresAtUnixMS int64  `json:"expires_at_unix_ms"`
}

type hostConfig struct {
	Journal            string            `json:"journal"`
	ExecutorID         string            `json:"executor_id"`
	ExecutorCredential string            `json:"executor_credential"`
	SignerKeyID        string            `json:"signer_key_id"`
	SignerPrivateKey   []byte            `json:"signer_private_key"`
	Roots              map[string]string `json:"roots"`
	Grants             []hostGrant       `json:"grants"`
}

type envelope struct {
	Request  wire.EffectRequest `json:"request"`
	Result   wire.EffectResult  `json:"result"`
	Receipt  wire.EffectReceipt `json:"receipt"`
	Expected effects.Binding    `json:"expected"`
}

type authenticator struct {
	executorID string
	credential [sha256.Size]byte
}

func (a authenticator) AuthenticateExecutor(credential string) (controlkernel.ExecutorPrincipal, error) {
	digest := sha256.Sum256([]byte(credential))
	if credential == "" || subtle.ConstantTimeCompare(digest[:], a.credential[:]) != 1 {
		return controlkernel.ExecutorPrincipal{}, errors.New("executor credential rejected")
	}
	return controlkernel.ExecutorPrincipal{ID: a.executorID}, nil
}

func loadConfig(path string) (hostConfig, error) {
	file, err := os.Open(path)
	if err != nil {
		return hostConfig{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return hostConfig{}, fmt.Errorf("host configuration must be a regular file")
	}
	raw, err := io.ReadAll(io.LimitReader(file, effects.MaxMessageBytes+1))
	if err != nil {
		return hostConfig{}, err
	}
	var config hostConfig
	if err := effects.DecodeStrict(raw, &config); err != nil {
		return hostConfig{}, fmt.Errorf("invalid host configuration: %w", err)
	}
	if !filepath.IsAbs(config.Journal) || config.ExecutorCredential == "" || len(config.SignerPrivateKey) != ed25519.PrivateKeySize || len(config.Grants) == 0 {
		return hostConfig{}, fmt.Errorf("host configuration requires absolute journal, credentials, signing key and grants")
	}
	if err := effects.ValidateSigningIdentity(config.SignerKeyID, config.SignerPrivateKey); err != nil {
		return hostConfig{}, err
	}
	seenRequests, seenGrants, seenNodes := make(map[string]bool), make(map[string]bool), make(map[string]bool)
	for _, grant := range config.Grants {
		if err := effects.ValidateBinding(effects.Binding{TaskID: grant.TaskID, NodeID: grant.NodeID, AttemptID: "configured",
			ExecutorID: config.ExecutorID, GrantID: grant.GrantID, LeaseID: "configured", Fence: 1}); err != nil {
			return hostConfig{}, err
		}
		path := ""
		if grant.Effect == "fs.read" {
			path = "configured"
		}
		if err := effects.ValidateRequest(wire.EffectRequest{ProtocolVersion: effects.ProtocolVersion,
			RequestID: grant.RequestID, ModuleHash: grant.RequestHash, Function: "configured", Effect: grant.Effect, Capability: grant.Capability, Path: path}); err != nil {
			return hostConfig{}, err
		}
		if seenRequests[grant.RequestID] || seenGrants[grant.GrantID] || seenNodes[grant.NodeID] || grant.ExpiresAtUnixMS <= time.Now().UnixMilli() ||
			grant.MaxBytes < 0 || grant.MaxBytes > effects.MaxValueBytes || (grant.Effect == "fs.read" && (grant.MaxBytes <= 0 || config.Roots[grant.RootID] == "")) {
			return hostConfig{}, fmt.Errorf("invalid, duplicate or expired host grant")
		}
		seenRequests[grant.RequestID], seenGrants[grant.GrantID], seenNodes[grant.NodeID] = true, true, true
	}
	return config, nil
}

func setupGrants(kernel *controlkernel.Kernel, config hostConfig, now time.Time) ([]effects.Grant, error) {
	seenNodes := make(map[string]bool)
	for _, grant := range config.Grants {
		if grant.TaskID == "" || grant.NodeID == "" || seenNodes[grant.NodeID] || grant.ExpiresAtUnixMS <= now.UnixMilli() || grant.MaxBytes < 0 || grant.MaxBytes > effects.MaxValueBytes ||
			(grant.Effect != "clock.read" && grant.Effect != "fs.read") || grant.Capability == "" {
			return nil, fmt.Errorf("invalid or expired host effect grant")
		}
		if grant.Effect == "fs.read" && (grant.MaxBytes <= 0 || config.Roots[grant.RootID] == "") {
			return nil, fmt.Errorf("fs.read grant requires a configured root and byte limit")
		}
		seenNodes[grant.NodeID] = true
		if task, exists := kernel.Task(grant.TaskID); exists {
			if task.Metadata["authority"] != "effect-broker-v1" {
				return nil, fmt.Errorf("configured task belongs to another control-plane owner")
			}
		} else if _, err := kernel.CreateTask(controlkernel.Task{ID: grant.TaskID, Goal: "Explicit local effect execution", Metadata: map[string]string{"authority": "effect-broker-v1"}}); err != nil {
			return nil, err
		}
		if node, exists := kernel.Node(grant.NodeID); exists {
			if node.TaskID != grant.TaskID || node.Kind != grant.Effect {
				return nil, fmt.Errorf("configured node belongs to another effect")
			}
		} else if _, err := kernel.AddNode(controlkernel.Node{ID: grant.NodeID, TaskID: grant.TaskID, Kind: grant.Effect,
			Deadline: time.UnixMilli(grant.ExpiresAtUnixMS), Budget: controlkernel.Budget{MaxReadBytes: grant.MaxBytes}}); err != nil {
			return nil, err
		}
	}
	grants := make([]effects.Grant, 0, len(config.Grants))
	for _, grant := range config.Grants {
		node, _ := kernel.Node(grant.NodeID)
		if node.State == controlkernel.NodePending {
			if err := kernel.TransitionNode(node.ID, controlkernel.NodeReady, controlkernel.LeaseToken{}); err != nil {
				return nil, err
			}
		}
		lease, exists := kernel.Lease(grant.NodeID)
		if !exists {
			var err error
			lease, err = kernel.ClaimLease(grant.NodeID, config.ExecutorCredential, config.ExecutorID, time.UnixMilli(grant.ExpiresAtUnixMS).Sub(now))
			if err != nil {
				return nil, err
			}
		}
		// Existing epochs are reused verbatim, including expired or observed
		// work. The broker denies/blocks them; startup never mints a retry.
		grants = append(grants, effects.Grant{Binding: effects.Binding{TaskID: grant.TaskID, NodeID: grant.NodeID,
			AttemptID: lease.AttemptID, ExecutorID: config.ExecutorID, GrantID: grant.GrantID, LeaseID: lease.ID, Fence: lease.Fence},
			RequestID: grant.RequestID, RequestHash: grant.RequestHash, Effect: grant.Effect, Capability: grant.Capability,
			RootID: grant.RootID, MaxBytes: grant.MaxBytes, ExpiresAt: time.UnixMilli(grant.ExpiresAtUnixMS)})
	}
	return grants, nil
}

func run(configPath string, input io.Reader, output io.Writer) error {
	config, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	reader, err := effects.OpenReader(config.Roots)
	if err != nil {
		return err
	}
	defer reader.Close()
	kernel, err := controlkernel.OpenKernel(config.Journal, controlkernel.WithExecutorAuthenticator(authenticator{
		executorID: config.ExecutorID, credential: sha256.Sum256([]byte(config.ExecutorCredential))}))
	if err != nil {
		return err
	}
	defer kernel.Close()
	grants, err := setupGrants(kernel, config, time.Now())
	if err != nil {
		return err
	}
	broker, err := effects.NewBroker(effects.Config{Kernel: kernel, Reader: reader, SignerKeyID: config.SignerKeyID,
		PrivateKey: config.SignerPrivateKey, Grants: grants})
	if err != nil {
		return err
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), effects.MaxMessageBytes)
	encoder := json.NewEncoder(output)
	for scanner.Scan() {
		var request wire.EffectRequest
		if err := effects.DecodeStrict(scanner.Bytes(), &request); err != nil {
			return fmt.Errorf("invalid request JSON: %w", err)
		}
		result, receipt, err := broker.Execute(context.Background(), config.ExecutorCredential, request)
		if err != nil {
			return err
		}
		expected, _ := broker.ExpectedBinding(request.RequestID)
		if err := encoder.Encode(envelope{Request: request, Result: result, Receipt: receipt, Expected: expected}); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func main() {
	config := flag.String("config", "", "absolute path to explicit host-owned authority configuration")
	flag.Parse()
	if *config == "" || !filepath.IsAbs(*config) || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: effect-broker --config ABSOLUTE_HOST_CONFIG.json")
		os.Exit(2)
	}
	if err := run(*config, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "effect-broker:", err)
		os.Exit(1)
	}
}
