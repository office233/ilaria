package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const coreCacheVersion = "core-aot-v1"

func defaultCoreCacheDir() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "swyp", coreCacheVersion), nil
}

func coreAOTCacheKey(source []byte, compilerIdentity, entry, profile, cpu string, lto, strip bool, compilerFlags ...string) string {
	h := sha256.New()
	parts := []string{
		coreCacheVersion,
		compilerIdentity,
		entry,
		profile,
		cpu,
		fmt.Sprintf("lto=%t", lto),
		fmt.Sprintf("strip=%t", strip),
		runtime.GOOS,
		runtime.GOARCH,
	}
	parts = append(parts, compilerFlags...)
	for _, part := range parts {
		_, _ = io.WriteString(h, part)
		_, _ = io.WriteString(h, "\x00")
	}
	_, _ = h.Write(source)
	return hex.EncodeToString(h.Sum(nil))
}

func compilerIdentity(path string) string {
	if resolved, err := exec.LookPath(path); err == nil {
		path = resolved
	}
	abs, err := filepath.Abs(path)
	if err == nil {
		path = abs
	}
	path = filepath.Clean(path)
	if runtime.GOOS == "windows" {
		path = strings.ToLower(path)
	}
	file, err := os.Open(path)
	if err != nil {
		return path
	}
	defer file.Close()
	h := sha256.New()
	if _, err := io.Copy(h, file); err != nil {
		return path
	}
	return path + "|sha256=" + hex.EncodeToString(h.Sum(nil))
}

func copyFileExclusive(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(dst)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(dst)
		return closeErr
	}
	return nil
}

func installCacheArtifact(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0700); err != nil {
		return err
	}
	if _, err := os.Stat(dst); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".swyp-cache-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	_ = tmp.Close()
	_ = os.Remove(tmpName)
	if err := copyFileExclusive(src, tmpName, 0700); err != nil {
		return err
	}
	if err := os.Rename(tmpName, dst); err != nil {
		_ = os.Remove(tmpName)
		if _, statErr := os.Stat(dst); statErr == nil {
			return nil
		}
		return err
	}
	return nil
}
