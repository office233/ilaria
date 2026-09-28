package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func TestWorkerRefinementGraph(t *testing.T) {
	var out bytes.Buffer
	request := `{"examples":[{"x":0,"y":0},{"x":1,"y":1}],"validation":[{"x":2,"y":4}]}`
	if err := worker(context.Background(), strings.NewReader(request), &out); err != nil {
		t.Fatal(err)
	}
	var response workerResponse
	if err := json.Unmarshal(out.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Status != "candidate" || response.Result.Rounds != 2 {
		t.Fatalf("%+v", response)
	}
	y, err := response.Graph.Evaluate(7, 64)
	if err != nil || y != 49 {
		t.Fatalf("%g %v", y, err)
	}
	hash := sha256.Sum256([]byte(response.Result.Source))
	if response.SourceSHA256 != hex.EncodeToString(hash[:]) {
		t.Fatal("wrong source hash")
	}
}

func TestWorkerRejectsUnboundedOrInvalidInput(t *testing.T) {
	for _, request := range []string{strings.Repeat(" ", 65537), `{"examples":[{"x":0}]}`, `{"examples":[{"x":0,"y":0}],"command":"erase"}`} {
		var out bytes.Buffer
		if err := worker(context.Background(), strings.NewReader(request), &out); err == nil {
			t.Fatal("accepted invalid request")
		}
		if out.Len() != 0 {
			t.Fatal("partial successful response")
		}
	}
}
