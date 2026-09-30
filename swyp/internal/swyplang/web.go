package swyplang

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// EmitJS emits a pure runner, also testable under Node. It has no host I/O APIs.
func (p *Program) EmitJS() (source string, err error) {
	c, err := p.check()
	if err != nil {
		return "", err
	}
	j := &javascript{checked: c, names: map[string]string{}}
	j.WriteString(jsRuntime)
	for i, name := range c.order {
		j.names[name] = fmt.Sprintf("f%d", i)
	}
	for _, name := range c.order {
		f := p.functions[name]
		env := &nativeScope{vars: map[string]string{}}
		var params []string
		for i, param := range f.params {
			n := fmt.Sprintf("p%d", i)
			env.vars[param] = n
			params = append(params, n)
		}
		j.line("function %s(%s) { tick(%s); if (++depth > 128) fail(%s,'call depth limit exceeded'); try {", j.names[name], strings.Join(params, ","), jsQuote(f.pos.String()), jsQuote(f.pos.String()))
		j.block(f.body, env)
		j.line("} finally { --depth; } }")
	}
	j.line("%s();\n}\n", j.names["main"])
	return j.String(), nil
}

type javascript struct {
	strings.Builder
	checked *checked
	names   map[string]string
	counter int
}

func (j *javascript) line(f string, args ...any) { fmt.Fprintf(&j.Builder, f+"\n", args...) }
func jsQuote(s string) string                    { b, _ := json.Marshal(s); return string(b) }
func (j *javascript) fresh() string              { j.counter++; return fmt.Sprintf("v%d", j.counter) }
func (j *javascript) block(body []*stmt, parent *nativeScope) {
	env := &nativeScope{vars: map[string]string{}, parent: parent}
	j.line("{")
	for _, s := range body {
		j.line("tick(%s);", jsQuote(s.pos.String()))
		switch s.kind {
		case "let":
			v := j.expression(s.value, env)
			name := j.fresh()
			j.line("let %s = %s;", name, v)
			env.vars[s.name] = name
		case "assign":
			j.line("%s = %s;", env.find(s.name), j.expression(s.value, env))
		case "expr":
			j.line("%s;", j.expression(s.value, env))
		case "return":
			j.line("return %s;", j.expression(s.value, env))
		case "if":
			j.line("if (%s)", j.expression(s.value, env))
			j.block(s.body, env)
			j.line("else")
			j.block(s.other, env)
		case "while":
			j.line("while (%s)", j.expression(s.value, env))
			j.block(s.body, env)
		}
	}
	j.line("}")
}
func (j *javascript) expression(e *expr, env *nativeScope) string {
	rhs := ""
	pos := jsQuote(e.pos.String())
	switch e.kind {
	case "literal":
		switch v := e.value.(type) {
		case float64:
			rhs = strconv.FormatFloat(v, 'g', 17, 64)
		case bool:
			rhs = strconv.FormatBool(v)
		case string:
			rhs = jsQuote(v)
		}
	case "variable":
		rhs = env.find(e.name)
	case "unary":
		rhs = e.name + "(" + j.expression(e.args[0], env) + ")"
	case "call":
		var args []string
		for _, a := range e.args {
			args = append(args, j.expression(a, env))
		}
		switch e.name {
		case "print":
			rhs = "printAt(" + pos
			if len(args) > 0 {
				rhs += "," + strings.Join(args, ",")
			}
			rhs += ")"
		case "eprint":
			rhs = "eprintAt(" + pos
			if len(args) > 0 {
				rhs += "," + strings.Join(args, ",")
			}
			rhs += ")"
		case "clock":
			rhs = "clockAt(" + pos + ")"
		case "arg":
			rhs = "argAt(" + pos + "," + strings.Join(args, ",") + ")"
		default:
			rhs = j.names[e.name] + "(" + strings.Join(args, ",") + ")"
		}
	case "binary":
		a, b := j.expression(e.args[0], env), j.expression(e.args[1], env)
		op := e.name
		if op == "==" {
			op = "==="
		}
		if op == "!=" {
			op = "!=="
		}
		if op == "/" || op == "%" {
			rhs = "divide(" + a + "," + b + "," + strconv.FormatBool(op == "%") + "," + pos + ")"
		} else {
			rhs = "(" + a + op + b + ")"
		}
		if j.checked.expressions[e].root().mask == numType {
			rhs = "finite(" + rhs + "," + pos + ")"
		}
	}
	return "(tick(" + pos + ")," + rhs + ")"
}

const jsRuntime = `"use strict";
function swypRun(args, write) {
 let steps=1000000000, depth=0;
 const started=performance.now();
 function fail(pos,message){throw new Error(pos+': '+message);}
 function tick(pos){if(--steps<0)fail(pos,'execution step limit exceeded');}
 function finite(x,pos){if(!Number.isFinite(x))fail(pos,'non-finite numeric result');return x;}
 function divide(x,y,mod,pos){if(y===0)fail(pos,mod?'remainder by zero':'division by zero');return mod?x%y:x/y;}
function printAt(pos,...values){tick(pos);write(values.map(String).join(' '));}
function eprintAt(pos,...values){tick(pos);console.error(...values);}
 function clockAt(pos){tick(pos);return (performance.now()-started)/1000;}
 function argAt(pos,i){tick(pos);if(!Number.isInteger(i)||i<0||i>=args.length)fail(pos,'argument index out of range');return finite(args[i],pos);}
 if(!Array.isArray(args)||args.some(x=>typeof x!=='number'||!Number.isFinite(x)))fail('arguments','expected finite numbers');
`

// EmitHTML wraps the checked program in an offline worker-based playground.
// Dynamic content uses textContent; the generated program is encoded as a JS
// string, preventing source literals from closing the script element.
func (p *Program) EmitHTML() (string, error) {
	js, err := p.EmitJS()
	if err != nil {
		return "", err
	}
	worker := js + `self.onmessage=function(event){try {swypRun(event.data,line=>self.postMessage({line}));self.postMessage({done:true});}catch(error){self.postMessage({error:String(error.message)});}};`
	return htmlPrefix + jsQuote(worker) + htmlSuffix, nil
}

const htmlPrefix = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Swyp Lang — Web Runner</title>
<style>body{margin:0;background:#101620;color:#e6edf3;font:16px system-ui}main{max-width:800px;margin:60px auto;padding:24px}h1{font-size:36px}label{display:block;margin:24px 0 8px}input{box-sizing:border-box;width:100%;padding:12px;background:#192434;color:inherit;border:1px solid #526175;border-radius:8px}button{padding:12px 24px;margin:16px 12px 16px 0;border:0;border-radius:8px;background:#93e0bd;color:#10231c;font-weight:700}button:disabled{opacity:.45}pre{white-space:pre-wrap;overflow-wrap:anywhere;min-height:160px;background:#192434;padding:20px;border-radius:12px}small{color:#aab8c6}</style>
<main><small>SWYP LANG / EXPERIMENTAL WEB TARGET</small><h1>One program. Another target.</h1>
<p>Run the compiled Swyp program locally in a browser worker.</p>
<label for="args">Numeric arguments (space-separated)</label><input id="args" placeholder="For the training demo: 2 200">
<button id="run">Run program</button><button id="stop" disabled>Stop</button>
<p id="status" role="status">Ready. No model service is needed to run this generated file.</p><pre id="output" aria-label="Program output"></pre>
<small>Prototype scalar runtime. This page is not a universal UI framework. Execution stops after 10 seconds or 1,000 output lines.</small></main>
<script>
const workerSource=`
const htmlSuffix = `;
const run=document.getElementById('run'),stop=document.getElementById('stop'),output=document.getElementById('output'),status=document.getElementById('status');
let worker=null,timer=null,url=null,lines=0;
function finish(message){if(worker)worker.terminate();worker=null;clearTimeout(timer);if(url)URL.revokeObjectURL(url);url=null;run.disabled=false;stop.disabled=true;status.textContent=message;}
stop.onclick=()=>finish('Stopped.');
run.onclick=()=>{const text=document.getElementById('args').value.trim();const args=text?text.split(/\s+/).map(Number):[];if(args.some(x=>!Number.isFinite(x))){status.textContent='Arguments must be finite numbers.';return;}
output.textContent='';lines=0;run.disabled=true;stop.disabled=false;status.textContent='Running…';
try {url=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));worker=new Worker(url);worker.onerror=e=>finish('Worker error: '+e.message);worker.onmessage=e=>{if('line' in e.data){output.textContent+=e.data.line+'\n';if(++lines>=1000)finish('Output limit reached.');}else if(e.data.error)finish(e.data.error);else if(e.data.done)finish('Completed.');};timer=setTimeout(()=>finish('Stopped: 10-second time limit.'),10000);worker.postMessage(args);}catch(e){finish('Unable to start worker: '+e.message);}};
</script></html>`
