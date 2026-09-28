package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"swypik-os/core/network"
	"swypik-os/internal/safepath"
)

type listArguments struct {
	Path string `json:"path"`
}

func validateList(raw json.RawMessage) error {
	var args listArguments
	if err := DecodeObject(raw, &args, 4096); err != nil {
		return err
	}
	if strings.HasPrefix(args.Path, "/") || strings.ContainsRune(args.Path, 0) || filepath.IsAbs(args.Path) || filepath.VolumeName(args.Path) != "" || strings.ContainsAny(args.Path, ":\\") {
		return fmt.Errorf("workspace-relative forward-slash path required")
	}
	if len(args.Path) > 512 {
		return fmt.Errorf("path too long")
	}
	for _, part := range strings.Split(strings.ReplaceAll(args.Path, "\\", "/"), "/") {
		if part != "." && strings.HasPrefix(part, ".") {
			return fmt.Errorf("hidden directories and traversal are unavailable")
		}
	}
	return nil
}

// These tools never expand scope to Home, read file contents, execute commands
// or probe third-party endpoints. Approved metadata goes to configured Nexus.
func ReadOnlyTools(root string) []Tool {
	return []Tool{
		{Spec: Spec{Name: "network.interfaces", Description: "Read host network adapters and addresses. Internet connectivity remains untested.", Arguments: "{}; no arguments"}, Validate: func(raw json.RawMessage) error { return DecodeObject(raw, &struct{}{}, 4096) }, Execute: func(ctx context.Context, _ json.RawMessage) (json.RawMessage, error) {
			s, err := network.Inspect(ctx)
			if err != nil {
				return nil, err
			}
			return json.Marshal(s)
		}},
		{Spec: Spec{Name: "workspace.list", Description: "List up to 32 non-hidden entries in the explicitly configured workspace; no file contents.", Arguments: `{"path":"."}; optional forward-slash relative path`}, Validate: validateList, Execute: func(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if err := validateList(raw); err != nil {
				return nil, err
			}
			var args listArguments
			_ = json.Unmarshal(raw, &args)
			path, err := safepath.ResolveRelative(root, args.Path)
			if err != nil {
				return nil, err
			}
			dir, err := os.Open(path)
			if err != nil {
				return nil, fmt.Errorf("workspace directory is unavailable")
			}
			defer dir.Close()
			info, err := dir.Stat()
			if err != nil || !info.IsDir() {
				return nil, fmt.Errorf("not a directory")
			}
			entries, err := dir.ReadDir(129)
			if err != nil && len(entries) == 0 && !errors.Is(err, io.EOF) {
				return nil, fmt.Errorf("cannot list workspace")
			}
			type entry struct {
				Name      string `json:"name"`
				Directory bool   `json:"directory"`
			}
			result := struct {
				Entries   []entry `json:"entries"`
				Truncated bool    `json:"truncated"`
			}{Entries: []entry{}, Truncated: len(entries) > 128}
			sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
			for _, e := range entries {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				if strings.HasPrefix(e.Name(), ".") || e.Type()&os.ModeSymlink != 0 {
					continue
				}
				if len(result.Entries) == 32 {
					result.Truncated = true
					break
				}
				result.Entries = append(result.Entries, entry{Name: e.Name(), Directory: e.IsDir()})
			}
			return json.Marshal(result)
		}},
	}
}
