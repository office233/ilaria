package coder

import "bytes"

const maxCommandOutput = 256 * 1024

// exec.Cmd serializes writes when stdout and stderr share the same writer.
// Consume all bytes while retaining a bounded preview so verbose commands
// cannot exhaust memory or deadlock waiting for their output to be drained.
type commandOutput struct {
	buffer    bytes.Buffer
	truncated bool
}

func (o *commandOutput) Write(p []byte) (int, error) {
	n := len(p)
	remaining := maxCommandOutput - o.buffer.Len()
	if len(p) > remaining {
		p = p[:remaining]
		o.truncated = true
	}
	_, _ = o.buffer.Write(p)
	return n, nil
}

func (o *commandOutput) String() string {
	if o.truncated {
		return o.buffer.String() + "\n[Output truncated at 256 KiB]"
	}
	return o.buffer.String()
}
