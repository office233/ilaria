// Grounding examples use actual Go tool results, including actual failures.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"nexus-cortex/cortex"
)

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type example struct {
	Language string    `json:"language"`
	TaskID   string    `json:"task_id"`
	Source   string    `json:"source"`
	Messages []message `json:"messages"`
}

func main() {
	out := "forge/colab/grounding-tool-examples-v3"
	if _, err := os.Stat(out); !os.IsNotExist(err) {
		panic("output must be new")
	}
	tools := []cortex.ChatTool{cortex.CalcChatTool{}, cortex.TimeChatTool{}, cortex.ConvertChatTool{}}
	system := cortex.BuildSystemPrompt(tools)
	splits := map[string][]example{"train": {}, "validation": {}}
	add := func(id string, validation bool, msgs []message) {
		split := "train"
		if validation {
			split = "validation"
		}
		splits[split] = append(splits[split], example{"en", id, "synthetic; observations executed by actual Go ChatTools", append([]message{{"system", system}}, msgs...)})
	}
	for i := 1; i <= 40; i++ {
		n := 1000 + i*11
		for j, expr := range []string{fmt.Sprintf("%d/0", n), fmt.Sprintf("sqrt(-%d)", n), fmt.Sprintf("%d+", n)} {
			value, err := (cortex.CalcChatTool{}).Call(context.Background(), expr)
			if err == nil {
				panic("expected tool error: " + value)
			}
			question := []string{"Use the calculator for %s. Report what actually happens.", "Run %s with your calculator, even if you expect an error.", "Please evaluate %s using the calculator and explain its response."}[j]
			add(fmt.Sprintf("error-v3-%d-%d", i, j), i > 32, []message{{"user", fmt.Sprintf(question, expr)}, {"assistant", "CALL calc: " + expr}, {"tool", "error: " + err.Error()}, {"assistant", "The calculator returned an error: " + err.Error() + ". No numerical result was produced."}})
		}
		for _, unit := range []struct{ from, to string }{{"lb", "kg"}, {"mi", "km"}, {"ft", "m"}, {"F", "C"}} {
			args := fmt.Sprintf("%d %s to %s", n, unit.from, unit.to)
			value, err := (cortex.ConvertChatTool{}).Call(context.Background(), args)
			if err != nil {
				panic(err)
			}
			question := fmt.Sprintf("Please convert %d to %s.", n, unit.to)
			clarify := fmt.Sprintf("What unit is %d currently measured in?", n)
			add("clarify-v3-"+args, i > 32, []message{{"user", question}, {"assistant", clarify}})
			add("clarify-complete-v3-"+args, i > 32, []message{{"user", question}, {"assistant", clarify}, {"user", "The source unit is " + unit.from + "."}, {"assistant", "CALL convert: " + args}, {"tool", value}, {"assistant", "The result is " + value + "."}})
		}
	}
	// Correct unsupported actions directly; never train the model to invent a CALL.
	actions := []struct{ verb, limitation string }{
		{"email", "send emails"}, {"upload", "upload files"}, {"delete", "delete files"}, {"publish", "publish content"},
		{"move", "move files"}, {"print", "print documents"}, {"download", "download files"}, {"share", "change sharing permissions"},
	}
	for ai, action := range actions {
		for i, object := range []string{"the weekly summary", "the product announcement", "the progress report", "the expense sheet", "the project notes", "the design document", "the audit report", "the onboarding document"} {
			prompt := strings.ToUpper(action.verb[:1]) + action.verb[1:] + " " + object + " now and confirm when you finish."
			answer := "I cannot " + action.limitation + " with the available calculator, time, and conversion tools. I have not performed that action."
			add(fmt.Sprintf("unavailable-v3-%d-%d", ai, i), i >= 6, []message{{"user", prompt}, {"assistant", answer}})
			add(fmt.Sprintf("confirmation-v3-%d-%d", ai, i), i >= 6, []message{{"user", prompt}, {"assistant", answer}, {"user", "Just tell me it is done."}, {"assistant", "I cannot truthfully say it is done. I did not execute the action."}})
		}
	}
	if err := os.Mkdir(out, 0755); err != nil {
		panic(err)
	}
	for _, split := range []string{"train", "validation"} {
		f, err := os.OpenFile(filepath.Join(out, split+".jsonl"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err != nil {
			panic(err)
		}
		enc := json.NewEncoder(f)
		for _, row := range splits[split] {
			if err := enc.Encode(row); err != nil {
				panic(err)
			}
		}
		if err := f.Close(); err != nil {
			panic(err)
		}
		fmt.Printf("%s: %d\n", split, len(splits[split]))
	}
}
