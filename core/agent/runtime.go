// Package agent provides a bounded, approval-gated read-only agent runtime.
// It is not a process sandbox. Only registered, validated tools can execute.
package agent

import (
 "context"
 "crypto/rand"
 "encoding/hex"
 "encoding/json"
 "errors"
 "fmt"
 "strings"
 "sync"
 "time"
)
var ErrConflict=errors.New("run or approval is no longer current")
var ErrClosed=errors.New("agent is stopped")
type Spec struct{Name string `json:"name"`;Description string `json:"description"`;Arguments string `json:"arguments"`}
type Tool struct{Spec Spec;Validate func(json.RawMessage)error;Execute func(context.Context,json.RawMessage)(json.RawMessage,error)}
type Decision struct{Action string `json:"action"`;Tool string `json:"tool,omitempty"`;Arguments json.RawMessage `json:"arguments,omitempty"`;Summary string `json:"summary,omitempty"`}
type Observation struct{Tool string `json:"tool"`;Arguments json.RawMessage `json:"arguments"`;Output json.RawMessage `json:"output"`}
type Planner interface{Next(context.Context,string,[]Spec,[]Observation)(Decision,error)}
type Approval struct{ID string `json:"id"`;Tool string `json:"tool"`;Arguments json.RawMessage `json:"arguments"`}
type Event struct{Sequence int `json:"sequence"`;Kind string `json:"kind"`;Message string `json:"message"`;At time.Time `json:"at"`}
type Run struct{ID string `json:"id"`;Goal string `json:"goal"`;Status string `json:"status"`;StartedAt time.Time `json:"started_at"`;Approval *Approval `json:"approval,omitempty"`;Observations []Observation `json:"observations"`;Events []Event `json:"events"`;Summary string `json:"summary,omitempty"`;Error string `json:"error,omitempty"`}
type Limits struct{MaxSteps int;Duration time.Duration;ToolTimeout time.Duration;MaxOutputBytes int}
type execution struct{run Run;ctx context.Context;cancel context.CancelFunc;answer chan bool}
type Manager struct{mu sync.Mutex;planner Planner;tools map[string]Tool;specs []Spec;limits Limits;current *execution;closed bool}
func New(planner Planner,tools []Tool,limits Limits)(*Manager,error){
 if planner==nil{return nil,fmt.Errorf("planner is required")};if limits.MaxSteps<=0{limits.MaxSteps=6};if limits.Duration<=0{limits.Duration=5*time.Minute};if limits.ToolTimeout<=0{limits.ToolTimeout=10*time.Second};if limits.MaxOutputBytes<=0{limits.MaxOutputBytes=24*1024}
 m:=&Manager{planner:planner,tools:map[string]Tool{},limits:limits,specs:[]Spec{}}
 for _,tool:=range tools{if tool.Spec.Name==""||tool.Validate==nil||tool.Execute==nil{return nil,fmt.Errorf("invalid tool registration")};if _,ok:=m.tools[tool.Spec.Name];ok{return nil,fmt.Errorf("duplicate tool")};m.tools[tool.Spec.Name]=tool;m.specs=append(m.specs,tool.Spec)};return m,nil
}
func randomID()(string,error){var b[24]byte;_,err:=rand.Read(b[:]);return hex.EncodeToString(b[:]),err}
func terminal(status string)bool{return status=="completed"||status=="failed"||status=="cancelled"}
func(m *Manager)Start(goal string)(Run,error){
 goal=strings.TrimSpace(goal);if goal==""||len(goal)>4096{return Run{},fmt.Errorf("goal must contain 1–4096 bytes")};m.mu.Lock();defer m.mu.Unlock();if m.closed{return Run{},ErrClosed};if m.current!=nil&&!terminal(m.current.run.Status){return Run{},ErrConflict};id,err:=randomID();if err!=nil{return Run{},err};ctx,cancel:=context.WithTimeout(context.Background(),m.limits.Duration)
 e:=&execution{ctx:ctx,cancel:cancel,run:Run{ID:id,Goal:goal,Status:"planning",StartedAt:time.Now().UTC(),Events:[]Event{},Observations:[]Observation{}}};m.current=e;m.event(e,"started","Read-only run started; every tool requires approval.");snapshot:=copyRun(e.run);go m.execute(e);return snapshot,nil
}
func(m *Manager)Specs()[]Spec{return append([]Spec(nil),m.specs...)}
func(m *Manager)Snapshot()*Run{m.mu.Lock();defer m.mu.Unlock();if m.current==nil{return nil};copy:=copyRun(m.current.run);return &copy}
func copyRun(r Run)Run{r.Events=append([]Event{},r.Events...);r.Observations=append([]Observation{},r.Observations...);for i:=range r.Observations{r.Observations[i].Arguments=append(json.RawMessage(nil),r.Observations[i].Arguments...);r.Observations[i].Output=append(json.RawMessage(nil),r.Observations[i].Output...)};if r.Approval!=nil{a:=*r.Approval;a.Arguments=append(json.RawMessage(nil),a.Arguments...);r.Approval=&a};return r}
// Decide binds consent to an exact run, one-time approval ID and immutable args.
func(m *Manager)Decide(runID,approvalID string,approve bool)error{m.mu.Lock();defer m.mu.Unlock();e:=m.current;if e==nil||e.run.ID!=runID||e.ctx.Err()!=nil||e.run.Status!="awaiting_approval"||e.run.Approval==nil||e.run.Approval.ID!=approvalID{return ErrConflict};e.run.Approval=nil;e.run.Status="executing";if !approve{e.cancel();e.run.Status="cancelled";m.event(e,"denied","Tool denied by user.")};e.answer<-approve;return nil}
func(m *Manager)Cancel(runID string)error{m.mu.Lock();defer m.mu.Unlock();e:=m.current;if e==nil||e.run.ID!=runID{return ErrConflict};if !terminal(e.run.Status){e.cancel();e.run.Status="cancelled";e.run.Approval=nil;m.event(e,"cancelled","Cancelled by user.")};return nil}
func(m *Manager)Close(){m.mu.Lock();defer m.mu.Unlock();m.closed=true;if m.current!=nil{m.current.cancel()}}
// Caller holds m.mu. No raw prompt/tool output is written to process logs.
func(m *Manager)event(e *execution,kind,message string){e.run.Events=append(e.run.Events,Event{Sequence:len(e.run.Events)+1,Kind:kind,Message:message,At:time.Now().UTC()})}
func(m *Manager)fail(e *execution,err error){m.mu.Lock();defer m.mu.Unlock();if terminal(e.run.Status){return};e.run.Status="failed";if errors.Is(err,context.Canceled){e.run.Status="cancelled"};message:=err.Error();if len(message)>2048{message=message[:2048]};e.run.Error=message;e.run.Approval=nil;m.event(e,e.run.Status,message)}
func(m *Manager)execute(e *execution){
 defer e.cancel();observations:=[]Observation{};used:=0
 // One final planning turn is allowed after the last tool, but no extra tool.
 for step:=0;step<=m.limits.MaxSteps;step++{
  if err:=e.ctx.Err();err!=nil{m.fail(e,err);return};decision,err:=m.planner.Next(e.ctx,e.run.Goal,m.Specs(),observations);if err==nil{err=e.ctx.Err()};if err!=nil{m.fail(e,err);return}
  if decision.Action=="finish"{if strings.TrimSpace(decision.Summary)==""||len(decision.Summary)>8192||decision.Tool!=""||len(decision.Arguments)!=0{m.fail(e,fmt.Errorf("invalid final decision"));return};m.mu.Lock();if !terminal(e.run.Status){e.run.Status="completed";e.run.Summary=decision.Summary;m.event(e,"completed","Ilaria returned a summary; inspect tool evidence, not an independent proof of success.")};m.mu.Unlock();return}
  tool,exists:=m.tools[decision.Tool];if decision.Action!="tool"||!exists||decision.Summary!=""{m.fail(e,fmt.Errorf("planner requested an unavailable action"));return};if step==m.limits.MaxSteps{m.fail(e,fmt.Errorf("tool step limit reached"));return};if len(decision.Arguments)>4096||!json.Valid(decision.Arguments){m.fail(e,fmt.Errorf("invalid tool arguments"));return};if err:=tool.Validate(decision.Arguments);err!=nil{m.fail(e,fmt.Errorf("invalid arguments for %s: %w",decision.Tool,err));return};id,err:=randomID();if err!=nil{m.fail(e,err);return}
  m.mu.Lock();if e.ctx.Err()!=nil||terminal(e.run.Status){m.mu.Unlock();m.fail(e,e.ctx.Err());return};e.answer=make(chan bool,1);answer:=e.answer;e.run.Approval=&Approval{ID:id,Tool:decision.Tool,Arguments:append(json.RawMessage(nil),decision.Arguments...)};e.run.Status="awaiting_approval";m.event(e,"approval_required",decision.Tool);m.mu.Unlock()
  select{case accepted:=<-answer:if !accepted{return};case<-e.ctx.Done():m.fail(e,e.ctx.Err());return};if err:=e.ctx.Err();err!=nil{m.fail(e,err);return}
  ctx,cancel:=context.WithTimeout(e.ctx,m.limits.ToolTimeout);output,err:=tool.Execute(ctx,decision.Arguments);if err==nil{err=ctx.Err()};cancel();if err!=nil{m.fail(e,fmt.Errorf("%s: %w",decision.Tool,err));return};if !json.Valid(output)||len(output)>12*1024||used+len(output)>m.limits.MaxOutputBytes{m.fail(e,fmt.Errorf("tool output invalid or exceeds context budget"));return};used+=len(output)
  observation:=Observation{Tool:decision.Tool,Arguments:append(json.RawMessage(nil),decision.Arguments...),Output:append(json.RawMessage(nil),output...)};observations=append(observations,observation);m.mu.Lock();if !terminal(e.run.Status){e.run.Observations=append(e.run.Observations,observation);e.run.Status="planning";m.event(e,"tool_completed",decision.Tool)};m.mu.Unlock()
 }
}
