// Package search implements Swypik's own bounded, persistent inverted index.
// Results come only from indexed documents; no external search API is used.
package search
import("encoding/json";"fmt";"html";"io";"math";"os";"path/filepath";"regexp";"sort";"strings";"sync";"time";"unicode")
const MaxDocuments=1000
const MaxTextBytes=32768
type Source struct{Title string `json:"title"`;URL string `json:"url"`;Snippet string `json:"snippet"`;Score float64 `json:"score"`;FetchedAt time.Time `json:"fetched_at"`;SHA256 string `json:"sha256"`}
type Result struct{Query string `json:"query"`;AIAnswer string `json:"ai_answer"`;Sources []Source `json:"sources"`;TrackersBlocked int `json:"trackers_blocked"`;AdsStripped int `json:"ads_stripped"`;LatencyMs int64 `json:"latency_ms"`;IndexedDocuments int `json:"indexed_documents"`}
type Document struct{URL string `json:"url"`;Title string `json:"title"`;Text string `json:"text"`;FetchedAt time.Time `json:"fetched_at"`;SHA256 string `json:"sha256"`}
type Engine struct{mu sync.RWMutex;crawlMu sync.Mutex;path string;docs map[string]Document;postings map[string]map[string]int;lengths map[string]int;totalLength int}
func NewEngine()*Engine{e,_:=Open("");return e}
func Open(path string)(*Engine,error){
 e:=&Engine{path:path,docs:map[string]Document{}}
 if path!=""{f,err:=os.Open(path);if err==nil{defer f.Close();info,err:=f.Stat();if err!=nil{return nil,err};if info.Size()>64<<20{return nil,fmt.Errorf("index exceeds size limit")};var disk struct{Version int `json:"version"`;Documents []Document `json:"documents"`};d:=json.NewDecoder(f);d.DisallowUnknownFields();if err:=d.Decode(&disk);err!=nil{return nil,fmt.Errorf("invalid index: %w",err)};if err:=d.Decode(new(interface{}));err!=io.EOF{return nil,fmt.Errorf("trailing index data")};if disk.Version!=1||len(disk.Documents)>MaxDocuments{return nil,fmt.Errorf("unsupported or oversized index")};for _,doc:=range disk.Documents{if err:=validDocument(doc);err!=nil{return nil,err};e.docs[doc.URL]=doc}}else if !os.IsNotExist(err){return nil,err}}
 e.rebuild();return e,nil
}
func validDocument(d Document)error{if _,err:=canonical(d.URL);err!=nil{return err};if len(d.Text)>MaxTextBytes||len(d.Title)>512||strings.TrimSpace(d.Text)==""{return fmt.Errorf("invalid document text")};return nil}
// Persist before committing the complete in-memory update.
func(e *Engine)Upsert(doc Document)error{if err:=validDocument(doc);err!=nil{return err};e.mu.Lock();defer e.mu.Unlock();old,exists:=e.docs[doc.URL];if !exists&&len(e.docs)>=MaxDocuments{return fmt.Errorf("index document limit reached")};e.docs[doc.URL]=doc;if err:=e.persist();err!=nil{if exists{e.docs[doc.URL]=old}else{delete(e.docs,doc.URL)};return err};e.rebuild();return nil}
func(e *Engine)Delete(raw string)error{e.mu.Lock();defer e.mu.Unlock();old,ok:=e.docs[raw];delete(e.docs,raw);if err:=e.persist();err!=nil{if ok{e.docs[raw]=old};return err};e.rebuild();return nil}
func(e *Engine)persist()error{
 if e.path==""{return nil};if err:=os.MkdirAll(filepath.Dir(e.path),0700);err!=nil{return err};docs:=make([]Document,0,len(e.docs));for _,d:=range e.docs{docs=append(docs,d)};sort.Slice(docs,func(i,j int)bool{return docs[i].URL<docs[j].URL});b,err:=json.Marshal(struct{Version int `json:"version"`;Documents []Document `json:"documents"`}{1,docs});if err!=nil{return err};f,err:=os.CreateTemp(filepath.Dir(e.path),".index-*");if err!=nil{return err};defer os.Remove(f.Name());if _,err=f.Write(b);err==nil{err=f.Sync()};closeErr:=f.Close();if err!=nil{return err};if closeErr!=nil{return closeErr};return os.Rename(f.Name(),e.path)
}
var fold=strings.NewReplacer("ă","a","â","a","î","i","ș","s","ş","s","ț","t","ţ","t")
func tokens(s string)[]string{return strings.FieldsFunc(fold.Replace(strings.ToLower(s)),func(r rune)bool{return !unicode.IsLetter(r)&&!unicode.IsNumber(r)})}
func(e *Engine)rebuild(){e.postings=map[string]map[string]int{};e.lengths=map[string]int{};e.totalLength=0;for id,d:=range e.docs{terms:=tokens(d.Title+" "+d.Title+" "+d.Text);e.lengths[id]=len(terms);e.totalLength+=len(terms);for _,term:=range terms{if len(term)>128{continue};if e.postings[term]==nil{e.postings[term]=map[string]int{}};e.postings[term][id]++}}}
func(e *Engine)Count()int{e.mu.RLock();defer e.mu.RUnlock();return len(e.docs)}
func(e *Engine)Search(query string)(*Result,error){
 start:=time.Now();query=strings.TrimSpace(query);if query==""||len(query)>512{return nil,fmt.Errorf("query must contain 1-512 bytes")};e.mu.RLock();defer e.mu.RUnlock();result:=&Result{Query:query,Sources:[]Source{},IndexedDocuments:len(e.docs)};if len(e.docs)==0{return result,nil};scores:=map[string]float64{};seen:=map[string]bool{};avg:=float64(e.totalLength)/float64(len(e.docs));if avg<1{avg=1}
 // BM25 k1=1.2, b=0.75; doubled title terms. Relevance is not proof of truth.
 for _,term:=range tokens(query){if seen[term]{continue};seen[term]=true;p:=e.postings[term];idf:=math.Log(1+(float64(len(e.docs)-len(p))+0.5)/(float64(len(p))+0.5));for id,n:=range p{tf:=float64(n);scores[id]+=idf*tf*2.2/(tf+1.2*(0.25+0.75*float64(e.lengths[id])/avg))}}
 for id,score:=range scores{d:=e.docs[id];r:=[]rune(d.Text);if len(r)>260{r=r[:260]};result.Sources=append(result.Sources,Source{d.Title,d.URL,string(r),score,d.FetchedAt,d.SHA256})};sort.Slice(result.Sources,func(i,j int)bool{a,b:=result.Sources[i],result.Sources[j];if a.Score==b.Score{return a.URL<b.URL};return a.Score>b.Score});if len(result.Sources)>10{result.Sources=result.Sources[:10]};result.LatencyMs=time.Since(start).Milliseconds();return result,nil
}
var scripts=regexp.MustCompile(`(?is)<(?:script|style)\b[^>]*>.*?</(?:script|style)\s*>`)
var tags=regexp.MustCompile(`<[^>]*>`)
func CleanText(raw string)string{return strings.Join(strings.Fields(html.UnescapeString(tags.ReplaceAllString(scripts.ReplaceAllString(raw," ")," ")))," ")}
