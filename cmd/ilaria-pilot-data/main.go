// ilaria-pilot-data builds a small synthetic tool-use pilot, not a general benchmark.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"nexus-cortex/cortex"
	"os"
	"path/filepath"
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
	out := flag.String("out", "forge/colab/pilot-examples-v1", "New output directory")
	flag.Parse()
	if _, err := os.Stat(*out); !os.IsNotExist(err) {
		panic("output must be a new directory")
	}
	tools := []cortex.ChatTool{cortex.CalcChatTool{}, cortex.TimeChatTool{}, cortex.ConvertChatTool{}}
	system := cortex.BuildSystemPrompt(tools)
	splits := map[string][]example{"train": {}, "validation": {}, "test": {}}
	add := func(id, question, answer string, tool cortex.ChatTool, args string) {
		msgs := []message{{"system", system}, {"user", question}}
		if tool != nil {
			result, err := tool.Call(context.Background(), args)
			if err != nil {
				result = "error: " + err.Error()
			}
			msgs = append(msgs, message{"assistant", fmt.Sprintf("CALL %s: %s", tool.Name(), args)}, message{"tool", result})
			if answer == "" {
				if err != nil {
					answer = "The tool failed. I cannot report a successful result for this request."
				} else {
					answer = "The result is " + result + "."
				}
			}
		}
		msgs = append(msgs, message{"assistant", answer})
		split := "train"
		hash := sha256.Sum256([]byte(id))
		if hash[0]%10 == 0 {
			split = "validation"
		} else if hash[0]%10 == 1 {
			split = "test"
		}
		splits[split] = append(splits[split], example{"en", id, "synthetic-pilot; tool observations executed with Nexus Go tools", msgs})
	}
	for i := 1; i <= 48; i++ {
		a, b := i*17+3, i*7+2
		for _, op := range []string{"+", "-", "*", "/"} {
			expr := fmt.Sprintf("%d%s%d", a, op, b)
			add("arithmetic-"+expr, "Calculate "+expr+" using the calculator.", "", cortex.CalcChatTool{}, expr)
		}
	}
	for i := 1; i <= 12; i++ {
		for _, units := range []struct{ from, to string }{{"km", "mi"}, {"kg", "lb"}, {"C", "F"}, {"m", "ft"}} {
			args := fmt.Sprintf("%d %s to %s", i*13, units.from, units.to)
			add("convert-"+args, "Convert "+args+".", "", cortex.ConvertChatTool{}, args)
		}
	}
	for _, expr := range []string{"1/0", "sqrt(-1)", "2+", "(4*3", "unknown(2)"} {
		add("invalid-"+expr, "Evaluate "+expr+". If it fails, explain that it failed.", "", cortex.CalcChatTool{}, expr)
	}
	for _, pair := range [][2]string{
		{"Who are you?", "I am Ilaria, the assistant for SwypikOS."},
		{"Can you send an email for me?", "I do not have an email tool in this session. I can help draft the message."},
		{"Delete the old files.", "I do not have a file-deletion tool in this session. I can help you identify which files you mean."},
		{"Open my browser.", "I do not have an application-launch tool in this session."},
		{"Did you change my settings?", "I have not changed your settings. No tool result confirms such an action."},
		{"Convert 15 to kilograms.", "What unit is the value 15 currently measured in?"},
		{"Calculate the total price.", "Please provide the item prices and quantities."},
		{"Translate hello into French.", "Bonjour."},
		{"Explain a checkpoint in one sentence.", "A checkpoint is a saved training state that can be used to resume a run."},
		{"What is a backup?", "A backup is a separate copy of data that can help restore it after loss or damage."},
		{"Are you sure the upload finished?", "I cannot confirm an upload without a result from an upload service."},
		{"Summarize: The meeting moved from Monday to Wednesday.", "The meeting is now on Wednesday."},
	} {
		add("direct-"+pair[0], pair[0], pair[1], nil, "")
	}
	if err := os.MkdirAll(*out, 0755); err != nil {
		panic(err)
	}
	for _, name := range []string{"train", "validation", "test"} {
		f, err := os.OpenFile(filepath.Join(*out, name+".jsonl"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err != nil {
			panic(err)
		}
		enc := json.NewEncoder(f)
		for _, row := range splits[name] {
			if err := enc.Encode(row); err != nil {
				panic(err)
			}
		}
		if err := f.Close(); err != nil {
			panic(err)
		}
		fmt.Printf("%s: %d examples\n", name, len(splits[name]))
	}
}
