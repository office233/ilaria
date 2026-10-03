// Package desktop is the platform-independent core of the SwypikOS desktop:
// tabs, commands, approvals and the text model the native window draws. It
// never touches a window handle, so it is fully testable without a GUI.
package desktop

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"swypik-os/config"
	"swypik-os/core/agent"
	"swypik-os/core/compute"
	"swypik-os/core/ilaria"
	resourcepolicy "swypik-os/core/resource"
	"swypik-os/core/search"
	"swypik-os/internal/safepath"
)

type Tab int

const (
	TabHome Tab = iota
	TabChat
	TabAgent
	TabSearch
	TabFiles
	TabCompute
	TabSettings
	TabCount
)

// TabNames are shown in the navigation, in order.
var TabNames = [TabCount]string{"Acasă", "Chat", "Agent", "Căutare", "Fișiere", "Calcul", "Setări"}

// TabIcons name the icon of each tab; the window maps names to glyphs.
var TabIcons = [TabCount]string{"grid", "chat", "terminal", "globe", "folder", "spark", "settings"}

// Tile is a launcher card on the home screen. Tone names a colour family.
type Tile struct {
	Title    string
	Subtitle string
	Icon     string
	Tone     string
	Action   string
	Category string
}

// TileCategories filter the home grid; "Toate" shows every tile.
var TileCategories = []string{"Toate", "Ilaria", "Workspace", "Sistem"}

type Kind int

const (
	KindInfo Kind = iota
	KindUser
	KindAssistant
	KindError
	KindTool
	KindResult
	KindCode
)

// Block is one visual unit of a tab's content. Action, when set, is passed to
// Activate on click.
type Block struct {
	Kind   Kind
	Title  string
	Body   string
	Action string
	// Icon optionally overrides the kind's default icon (see TabIcons names).
	Icon string
}

// Prompt is a decision the user must take before anything else happens.
type Prompt struct {
	ID       string // approval id; the window enforces a minimum display time per id
	Approval bool   // true for agent tool approvals, false for confirmations
	Title    string
	Body     string
	Confirm  string
	Reject   string
}

// View is an immutable snapshot for rendering.
type View struct {
	Tab Tab
	// Eyebrow, Title and Subtitle form the page heading.
	Eyebrow  string
	Title    string
	Subtitle string
	// Empty is shown centred when there are no blocks.
	Empty      string
	Tiles      []Tile
	Connection string
	// Chat is the Ilaria conversation shown in the panel above the command
	// bar; ChatOpen asks the window to show that panel.
	Chat        []Block
	ChatOpen    bool
	ChatBusy    bool
	Blocks      []Block
	Prompt      *Prompt
	Busy        bool
	BusyLabel   string
	Status      string
	Placeholder string
	// Live is true while something may change without user input (agent run,
	// background task), so the window should keep refreshing.
	Live bool
}

// Deps are the services the desktop drives. All fields except Notify are required.
type Deps struct {
	Chat            *ilaria.Engine
	Health          func(context.Context) error
	Agent           *agent.Manager
	Search          *search.Engine
	Workspace       string
	SettingsPath    string
	Settings        config.Settings
	TokenConfigured bool
	// ApplyIlaria switches the live Ilaria endpoint after the user changes it.
	ApplyIlaria func(url string) error
	Compute     func(ctx context.Context, contribute bool, coordinator string) compute.Status
	// Notify asks the window to repaint; it must be safe from any goroutine.
	Notify func()
}

type pending struct {
	prompt Prompt
	run    func()
}

type Controller struct {
	mu           sync.Mutex
	d            Deps
	tab          Tab
	logs         [TabCount][]Block
	results      []Block // current search results
	filesDir     string  // workspace-relative, "" = root
	filesList    []Block // cached listing; refreshed on navigation, not per paint
	preview      *Block
	compute      *compute.Status
	busy         bool
	busyLabel    string
	cancel       context.CancelFunc
	pending      *pending
	chatOpen     bool
	chatBusy     bool
	history      []string
	histPos      int
	maxHistory   int
	maxLogBlocks int
}

func New(d Deps) *Controller {
	policy := resourcepolicy.Default()
	maxHistory := policy.MaxChatHistoryMessages
	if maxHistory < 20 {
		maxHistory = 20
	}
	maxLogs := maxHistory * 4
	if maxLogs < 80 {
		maxLogs = 80
	}
	if maxLogs > 400 {
		maxLogs = 400
	}
	c := &Controller{d: d, tab: TabHome, maxHistory: maxHistory, maxLogBlocks: maxLogs}
	c.logs[TabSearch] = []Block{{Kind: KindInfo, Body: "Motorul tău de căutare: niciun Google, Bing sau DuckDuckGo. /index adaugă fișierele din workspace, /crawl https://site/ adaugă un site (cu confirmare)."}}
	return c
}

func (c *Controller) notify() {
	if c.d.Notify != nil {
		c.d.Notify()
	}
}

func (c *Controller) addLocked(tab Tab, b Block) {
	c.logs[tab] = append(c.logs[tab], b)
	limit := c.maxLogBlocks
	if limit <= 0 {
		limit = 400
	}
	if len(c.logs[tab]) > limit {
		// Reuse the existing backing array instead of allocating a fresh
		// slice on every overflow. Once warm, UI logs stay bounded without heap
		// growth from retention trimming.
		copy(c.logs[tab], c.logs[tab][len(c.logs[tab])-limit:])
		c.logs[tab] = c.logs[tab][:limit]
	}
}

func (c *Controller) addHistoryLocked(text string) {
	maxHistory := c.maxHistory
	if maxHistory <= 0 {
		maxHistory = 100
	}
	if len(c.history) < maxHistory {
		c.history = append(c.history, text)
	} else {
		copy(c.history, c.history[1:])
		c.history[maxHistory-1] = text
	}
	c.histPos = len(c.history)
}

func (c *Controller) add(tab Tab, b Block) {
	c.mu.Lock()
	c.addLocked(tab, b)
	c.mu.Unlock()
	c.notify()
}

// startLocked runs fn in the background. Only one background task runs at a
// time; the agent has its own lifecycle and is not counted here.
func (c *Controller) startLocked(tab Tab, label string, timeout time.Duration, fn func(context.Context)) {
	if c.busy {
		c.addLocked(tab, Block{Kind: KindError, Body: "Altă operație rulează (" + c.busyLabel + "). Scrie /cancel pentru a o opri."})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	c.busy, c.busyLabel, c.cancel = true, label, cancel
	go func() {
		defer func() {
			if r := recover(); r != nil {
				c.add(tab, Block{Kind: KindError, Body: fmt.Sprintf("Operația a eșuat: %v", r)})
			}
			cancel()
			c.mu.Lock()
			c.busy, c.busyLabel, c.cancel = false, "", nil
			c.mu.Unlock()
			c.notify()
		}()
		fn(ctx)
	}()
}

func (c *Controller) SetTab(t Tab) {
	if t < 0 || t >= TabCount {
		return
	}
	c.mu.Lock()
	c.tab = t
	if t == TabFiles {
		c.filesList = c.listFilesLocked()
	}
	refresh := t == TabCompute && c.compute == nil
	c.mu.Unlock()
	if refresh {
		c.Submit("/refresh")
	}
	c.notify()
}

func (c *Controller) Tab() Tab {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.tab
}

// HistoryPrev and HistoryNext recall previously submitted input.
func (c *Controller) HistoryPrev() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.history) == 0 {
		return ""
	}
	if c.histPos > 0 {
		c.histPos--
	}
	return c.history[c.histPos]
}

func (c *Controller) HistoryNext() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.histPos < len(c.history)-1 {
		c.histPos++
		return c.history[c.histPos]
	}
	c.histPos = len(c.history)
	return ""
}

// Submit handles one line typed by the user in the current tab.
func (c *Controller) Submit(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	c.mu.Lock()
	if !strings.HasPrefix(text, "/refresh") {
		c.addHistoryLocked(text)
	}
	tab := c.tab
	cmd, arg := text, ""
	if strings.HasPrefix(text, "/") {
		if i := strings.IndexByte(text, ' '); i > 0 {
			cmd, arg = text[:i], strings.TrimSpace(text[i+1:])
		}
		cmd = strings.ToLower(cmd)
	} else {
		cmd = ""
	}
	switch cmd {
	case "/help":
		c.addLocked(tab, Block{Kind: KindInfo, Title: "Comenzi", Body: helpText})
		c.mu.Unlock()
		c.notify()
		return
	case "/cancel":
		c.mu.Unlock()
		c.Cancel()
		return
	}
	if c.pending != nil {
		c.addLocked(tab, Block{Kind: KindError, Body: "Răspunde întâi la confirmarea afișată (Enter pe buton, F8 sau F9)."})
		c.mu.Unlock()
		c.notify()
		return
	}
	switch tab {
	case TabHome:
		c.homeLocked(cmd, arg, text)
	case TabChat:
		c.chatLocked(cmd, text)
	case TabAgent:
		c.agentLocked(cmd, text)
	case TabSearch:
		c.searchLocked(cmd, arg, text)
	case TabFiles:
		c.filesLocked(text)
	case TabCompute:
		c.computeLocked(cmd, arg)
	case TabSettings:
		c.settingsLocked(cmd, arg)
	}
	c.mu.Unlock()
	c.notify()
}

const helpText = `Oriunde: /help, /cancel (oprește operația curentă sau rularea agentului)
Chat: scrie un mesaj; /new începe o conversație nouă
Agent: scrie un obiectiv; /resume reia o rulare întreruptă; F8 aprobă, F9 refuză un pas
Căutare: scrie cuvinte; /index [dosar] indexează fișiere locale; /crawl URL [pagini] indexează un site
Fișiere: click pe dosar sau fișier; scrie o cale relativă; .. urcă un nivel
Calcul: /on sau /off pentru contribuția GPU la Ilaria; /coordinator URL; /refresh
Setări: /ilaria URL schimbă serviciul Ilaria; /test verifică conexiunea; /workspace DOSAR`

// homeLocked makes the command bar "ask Ilaria or go anywhere": a tab name
// navigates, known commands run in their tab, anything else starts a chat.
func (c *Controller) homeLocked(cmd, arg, text string) {
	target := foldASCII(strings.TrimPrefix(strings.TrimPrefix(strings.ToLower(text), "deschide "), "open "))
	for i, name := range TabNames {
		if foldASCII(name) == target {
			c.tab = Tab(i)
			if c.tab == TabFiles {
				c.filesList = c.listFilesLocked()
			}
			return
		}
	}
	switch cmd {
	case "/index", "/crawl":
		c.tab = TabSearch
		c.searchLocked(cmd, arg, text)
		return
	case "/test", "/ilaria", "/workspace":
		c.tab = TabSettings
		c.settingsLocked(cmd, arg)
		return
	}
	c.chatLocked(cmd, text)
}

// SubmitChat sends text to Ilaria regardless of the current tab (the chat
// panel above the command bar). /new starts a new conversation.
func (c *Controller) SubmitChat(text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	c.mu.Lock()
	c.addHistoryLocked(text)
	cmd := ""
	if strings.HasPrefix(text, "/") {
		cmd = strings.ToLower(strings.Fields(text)[0])
	}
	c.chatLocked(cmd, text)
	c.chatOpen = true
	c.mu.Unlock()
	c.notify()
}

// Refresh reloads what the current tab shows.
func (c *Controller) Refresh() {
	switch c.Tab() {
	case TabFiles:
		c.mu.Lock()
		c.filesList = c.listFilesLocked()
		c.mu.Unlock()
		c.notify()
	case TabCompute:
		c.Submit("/refresh")
	default:
		c.notify()
	}
}

// OpenChat and CloseChat show or hide the Ilaria panel.
func (c *Controller) OpenChat() {
	c.mu.Lock()
	c.chatOpen = true
	c.mu.Unlock()
	c.notify()
}

func (c *Controller) CloseChat() {
	c.mu.Lock()
	c.chatOpen = false
	if c.tab == TabChat {
		c.tab = TabHome
	}
	c.mu.Unlock()
	c.notify()
}

func foldASCII(s string) string {
	return strings.NewReplacer("ă", "a", "â", "a", "î", "i", "ș", "s", "ş", "s", "ț", "t", "ţ", "t").Replace(strings.ToLower(strings.TrimSpace(s)))
}

func (c *Controller) chatLocked(cmd, text string) {
	if cmd == "/new" {
		c.d.Chat.ClearHistory()
		c.logs[TabChat] = nil
		return
	}
	if cmd != "" {
		c.addLocked(TabChat, Block{Kind: KindError, Body: "Comandă necunoscută în Chat. /help arată comenzile."})
		return
	}
	c.addLocked(TabChat, Block{Kind: KindUser, Body: text})
	c.chatOpen = true
	c.startLocked(TabChat, "Ilaria răspunde", 3*time.Minute, func(ctx context.Context) {
		reply, err := c.d.Chat.ProcessPromptContext(ctx, text)
		if err != nil {
			c.add(TabChat, Block{Kind: KindError, Title: "Ilaria nu a răspuns", Body: err.Error()})
			return
		}
		c.add(TabChat, Block{Kind: KindAssistant, Title: "Ilaria", Body: reply})
	})
}

func (c *Controller) agentLocked(cmd, text string) {
	run := c.d.Agent.Snapshot()
	switch cmd {
	case "/resume":
		if run == nil || run.Status != "interrupted" {
			c.addLocked(TabAgent, Block{Kind: KindError, Body: "Nu există o rulare întreruptă de reluat."})
			return
		}
		if _, err := c.d.Agent.Resume(run.ID); err != nil {
			c.addLocked(TabAgent, Block{Kind: KindError, Body: "Nu se poate relua: " + err.Error()})
		}
		return
	case "":
	default:
		c.addLocked(TabAgent, Block{Kind: KindError, Body: "Comandă necunoscută în Agent. /help arată comenzile."})
		return
	}
	if _, err := c.d.Agent.Start(text); err != nil {
		msg := err.Error()
		if err == agent.ErrConflict {
			msg = "O rulare este încă activă. Aprob-o, refuz-o sau scrie /cancel."
		}
		c.addLocked(TabAgent, Block{Kind: KindError, Body: msg})
		return
	}
	// A new run replaces the previous transcript; notes from before are kept.
	c.logs[TabAgent] = nil
}

func (c *Controller) searchLocked(cmd, arg, text string) {
	if cmd != "" {
		c.results = nil // command output replaces the previous result list
	}
	switch cmd {
	case "/index":
		dir := c.d.Workspace
		if arg != "" {
			dir = arg
		}
		c.startLocked(TabSearch, "Indexez "+dir, 30*time.Minute, func(ctx context.Context) {
			rep, err := c.d.Search.IndexDirectory(ctx, dir, 0)
			if err != nil {
				c.add(TabSearch, Block{Kind: KindError, Title: "Indexarea a eșuat", Body: err.Error()})
				return
			}
			c.add(TabSearch, Block{Kind: KindInfo, Title: "Indexare locală terminată", Body: fmt.Sprintf("%s\n%d fișiere text găsite, %d actualizate, %d eliminate, %d sărite.", rep.Root, rep.Scanned, rep.Indexed, rep.Removed, rep.Skipped)})
		})
	case "/crawl":
		fields := strings.Fields(arg)
		if len(fields) == 0 {
			c.addLocked(TabSearch, Block{Kind: KindError, Body: "Folosește: /crawl https://site.ro/ [pagini]"})
			return
		}
		pages := 16
		if len(fields) > 1 {
			if n, err := strconv.Atoi(fields[1]); err == nil && n >= 1 && n <= search.MaxCrawlPages {
				pages = n
			}
		}
		seed := fields[0]
		if !strings.Contains(seed, "://") {
			seed = "https://" + seed
		}
		c.pending = &pending{
			prompt: Prompt{Title: "Contactez un site?", Body: fmt.Sprintf("Swypik va accesa %s și va citi până la %d pagini de pe același site, respectând robots.txt. Adresele private sau locale sunt blocate.", seed, pages), Confirm: "Indexează (F8)", Reject: "Anulează (F9)"},
			run: func() {
				c.startLocked(TabSearch, "Crawl "+seed, 6*time.Minute, func(ctx context.Context) {
					rep, err := c.d.Search.Crawl(ctx, seed, pages)
					body := fmt.Sprintf("%s\n%d pagini citite, %d indexate, %d sărite.", rep.Origin, rep.Fetched, rep.Indexed, rep.Skipped)
					if len(rep.Errors) > 0 {
						body += "\nErori: " + strings.Join(rep.Errors[:min(3, len(rep.Errors))], "; ")
					}
					if err != nil {
						c.add(TabSearch, Block{Kind: KindError, Title: "Crawl oprit", Body: err.Error() + "\n" + body})
						return
					}
					c.add(TabSearch, Block{Kind: KindInfo, Title: "Crawl terminat", Body: body})
				})
			},
		}
	case "":
		r, err := c.d.Search.Search(text)
		if err != nil {
			c.addLocked(TabSearch, Block{Kind: KindError, Body: err.Error()})
			return
		}
		c.results = []Block{{Kind: KindInfo, Title: fmt.Sprintf("%d rezultate pentru „%s”", r.Matches, r.Query), Body: fmt.Sprintf("%d documente în index · %d ms", r.IndexedDocuments, r.LatencyMs)}}
		if r.IndexedDocuments == 0 {
			c.results[0].Body = "Indexul este gol. Adaugă conținut cu /index sau /crawl URL."
		}
		for _, s := range r.Sources {
			c.results = append(c.results, Block{Kind: KindResult, Title: s.Title, Body: displayURL(s.URL) + "\n" + s.Snippet, Action: "open:" + s.URL})
		}
	default:
		c.addLocked(TabSearch, Block{Kind: KindError, Body: "Comandă necunoscută în Căutare. /help arată comenzile."})
	}
}

func displayURL(u string) string {
	if p, ok := search.FilePath(u); ok {
		return p
	}
	return u
}

func (c *Controller) filesLocked(text string) {
	c.preview = nil
	target := text
	if text == ".." {
		target = filepath.ToSlash(filepath.Dir(filepath.FromSlash(c.filesDir)))
		if target == "." {
			target = ""
		}
	} else if c.filesDir != "" {
		target = c.filesDir + "/" + text
	}
	c.openFileLocked(target)
}

// openFileLocked navigates to a directory or previews a text file, strictly
// inside the workspace.
func (c *Controller) openFileLocked(rel string) {
	rel = strings.Trim(filepath.ToSlash(rel), "/")
	path, err := safepath.ResolveRelative(c.d.Workspace, rel)
	if err != nil {
		c.addLocked(TabFiles, Block{Kind: KindError, Body: err.Error()})
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		c.addLocked(TabFiles, Block{Kind: KindError, Body: err.Error()})
		return
	}
	if info.IsDir() {
		c.filesDir = rel
		c.preview = nil
		c.filesList = c.listFilesLocked()
		return
	}
	body := "Fișierul este prea mare pentru previzualizare."
	if info.Size() <= 256*1024 {
		if data, err := os.ReadFile(path); err != nil {
			body = err.Error()
		} else if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
			body = "Fișier binar; nu este afișat."
		} else {
			body = string(data)
		}
	}
	c.preview = &Block{Kind: KindCode, Title: rel, Body: body}
}

func (c *Controller) filesBlocksLocked() []Block {
	if c.preview != nil {
		return []Block{{Kind: KindResult, Title: "← Înapoi la /" + c.filesDir, Action: "files:" + c.filesDir}, *c.preview}
	}
	if c.filesList == nil {
		c.filesList = c.listFilesLocked()
	}
	return append([]Block(nil), c.filesList...)
}

func (c *Controller) listFilesLocked() []Block {
	dir := filepath.Join(c.d.Workspace, filepath.FromSlash(c.filesDir))
	var blocks []Block
	if c.filesDir != "" {
		blocks = append(blocks, Block{Kind: KindInfo, Title: "/" + c.filesDir, Body: dir, Icon: "folder"})
		blocks = append(blocks, Block{Kind: KindResult, Title: "..", Body: "Dosarul părinte", Action: "files:" + filepath.ToSlash(filepath.Dir(filepath.FromSlash(c.filesDir)))})
	}
	if len(blocks) == 0 {
		blocks = nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return append(blocks, Block{Kind: KindError, Body: err.Error()})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDir() != entries[j].IsDir() {
			return entries[i].IsDir()
		}
		return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
	})
	for i, e := range entries {
		if i >= 500 {
			blocks = append(blocks, Block{Kind: KindInfo, Body: fmt.Sprintf("… încă %d intrări", len(entries)-i)})
			break
		}
		rel := strings.TrimPrefix(c.filesDir+"/"+e.Name(), "/")
		detail := "dosar"
		if !e.IsDir() {
			if info, err := e.Info(); err == nil {
				detail = humanSize(info.Size()) + " · " + info.ModTime().Format("02.01.2006 15:04")
			}
		}
		name := e.Name()
		if e.IsDir() {
			name += "/"
		}
		blocks = append(blocks, Block{Kind: KindResult, Title: name, Body: detail, Action: "files:" + rel})
	}
	return blocks
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

func (c *Controller) computeLocked(cmd, arg string) {
	switch cmd {
	case "/on", "/off":
		c.d.Settings.Compute.Contribute = cmd == "/on"
		if err := config.SaveSettings(c.d.SettingsPath, c.d.Settings); err != nil {
			c.addLocked(TabCompute, Block{Kind: KindError, Body: "Nu am putut salva setările: " + err.Error()})
			return
		}
	case "/coordinator":
		c.d.Settings.Compute.CoordinatorURL = arg
		if err := config.SaveSettings(c.d.SettingsPath, c.d.Settings); err != nil {
			c.addLocked(TabCompute, Block{Kind: KindError, Body: err.Error()})
			return
		}
		if _, err := config.LoadSettings(c.d.SettingsPath); err != nil {
			c.addLocked(TabCompute, Block{Kind: KindError, Body: err.Error()})
			return
		}
	case "/refresh":
	default:
		c.addLocked(TabCompute, Block{Kind: KindError, Body: "Folosește /on, /off, /coordinator URL sau /refresh."})
		return
	}
	contribute, coordinator := c.d.Settings.Compute.Contribute, c.d.Settings.Compute.CoordinatorURL
	c.startLocked(TabCompute, "Detectez GPU", 10*time.Second, func(ctx context.Context) {
		s := c.d.Compute(ctx, contribute, coordinator)
		c.mu.Lock()
		c.compute = &s
		c.mu.Unlock()
	})
}

func (c *Controller) computeBlocksLocked() []Block {
	blocks := []Block{{Kind: KindInfo, Title: "Contribuția la antrenarea Ilaria", Body: "Când coordonatorul Ilaria va fi gata, dispozitivele care aleg explicit să participe vor primi sarcini de antrenare verificabile. Nimic nu rulează fără acordul tău; poți opri oricând."}}
	s := c.compute
	if s == nil {
		return append(blocks, Block{Kind: KindInfo, Body: "Se detectează hardware-ul…"})
	}
	if len(s.GPUs) == 0 {
		body := "Niciun GPU NVIDIA detectat (nvidia-smi indisponibil). Alte plăci nu sunt detectate încă de această versiune."
		if s.DetectError != "" {
			body = s.DetectError
		}
		blocks = append(blocks, Block{Kind: KindTool, Title: "GPU", Body: body, Icon: "chip"})
	}
	for _, g := range s.GPUs {
		name := g.Name
		if !strings.HasPrefix(strings.ToUpper(name), strings.ToUpper(g.Vendor)) {
			name = g.Vendor + " " + name
		}
		blocks = append(blocks, Block{Kind: KindTool, Title: name, Body: fmt.Sprintf("Memorie: %d MB · Driver: %s · Utilizare acum: %d%%", g.MemoryMB, g.DriverVersion, g.Utilization), Icon: "chip"})
	}
	state := "OPRITĂ"
	if s.Contribute {
		state = "PERMISĂ de tine"
	}
	coord := s.Coordinator
	if coord == "" {
		coord = "neconfigurat"
	}
	reason := "Contribuția este oprită. Nimic nu rulează pe acest GPU pentru Ilaria."
	switch {
	case s.Contribute && s.Coordinator == "":
		reason = "Ai permis contribuția, dar niciun coordonator Ilaria nu este configurat. Nimic nu rulează."
	case s.Contribute:
		reason = "Protocolul coordonatorului nu este încă implementat în această versiune; nu se acceptă sarcini."
	}
	return append(blocks, Block{Kind: KindTool, Title: "Contribuție: " + state, Body: "Coordonator: " + coord + "\n" + reason, Icon: "link"})
}

func (c *Controller) settingsLocked(cmd, arg string) {
	switch cmd {
	case "/ilaria":
		u, err := config.ValidateIlariaURL(arg)
		if err != nil {
			c.addLocked(TabSettings, Block{Kind: KindError, Body: err.Error()})
			return
		}
		if c.d.ApplyIlaria != nil {
			if err := c.d.ApplyIlaria(u); err != nil {
				c.addLocked(TabSettings, Block{Kind: KindError, Body: err.Error()})
				return
			}
		}
		c.d.Settings.IlariaURL = u
		if err := config.SaveSettings(c.d.SettingsPath, c.d.Settings); err != nil {
			c.addLocked(TabSettings, Block{Kind: KindError, Body: "Nu am putut salva: " + err.Error()})
			return
		}
		c.addLocked(TabSettings, Block{Kind: KindInfo, Body: "Serviciul Ilaria este acum " + u + ". Scrie /test pentru a verifica."})
	case "/test":
		c.startLocked(TabSettings, "Verific Ilaria", 20*time.Second, func(ctx context.Context) {
			if err := c.d.Health(ctx); err != nil {
				c.add(TabSettings, Block{Kind: KindError, Title: "Ilaria indisponibilă", Body: err.Error()})
				return
			}
			c.add(TabSettings, Block{Kind: KindInfo, Title: "Ilaria răspunde", Body: "GET /health a reușit."})
		})
	case "/workspace":
		abs, err := filepath.Abs(arg)
		if err == nil {
			var info os.FileInfo
			if info, err = os.Stat(abs); err == nil && !info.IsDir() {
				err = fmt.Errorf("nu este un dosar")
			}
		}
		if err != nil {
			c.addLocked(TabSettings, Block{Kind: KindError, Body: err.Error()})
			return
		}
		c.d.Settings.Workspace = abs
		if err := config.SaveSettings(c.d.SettingsPath, c.d.Settings); err != nil {
			c.addLocked(TabSettings, Block{Kind: KindError, Body: err.Error()})
			return
		}
		c.addLocked(TabSettings, Block{Kind: KindInfo, Body: "Workspace salvat: " + abs + ". Repornește SwypikOS pentru a-l folosi."})
	default:
		c.addLocked(TabSettings, Block{Kind: KindError, Body: "Folosește /ilaria URL, /test sau /workspace DOSAR."})
	}
}

func (c *Controller) settingsBlocksLocked() []Block {
	token := "nesetat (necesar pentru HTTPS; pune-l în ilaria.token sau ILARIA_API_TOKEN)"
	if c.d.TokenConfigured {
		token = "configurat (nu este afișat)"
	}
	return []Block{
		{Kind: KindTool, Title: "Serviciul Ilaria", Body: c.d.Settings.IlariaURL + "\nToken: " + token, Icon: "globe"},
		{Kind: KindTool, Title: "Workspace", Body: c.d.Workspace, Icon: "folder"},
		{Kind: KindTool, Title: "Fișierul de setări", Body: c.d.SettingsPath, Icon: "settings"},
		{Kind: KindTool, Title: "Index de căutare", Body: fmt.Sprintf("%d documente", c.d.Search.Count()), Icon: "search"},
	}
}

// Activate handles a click on a block action. It returns an external action
// ("open:<url>") the window performs with the OS, or "" when handled here.
func (c *Controller) Activate(action string) string {
	switch {
	case strings.HasPrefix(action, "files:"):
		c.mu.Lock()
		c.openFileLocked(strings.TrimPrefix(action, "files:"))
		c.mu.Unlock()
		c.notify()
		return ""
	case strings.HasPrefix(action, "open:"), strings.HasPrefix(action, "fill:"):
		return action
	case action == "chat:open":
		c.OpenChat()
	case strings.HasPrefix(action, "tab:"):
		if n, err := strconv.Atoi(strings.TrimPrefix(action, "tab:")); err == nil {
			c.SetTab(Tab(n))
		}
	case strings.HasPrefix(action, "run:"):
		parts := strings.SplitN(strings.TrimPrefix(action, "run:"), ":", 2)
		if n, err := strconv.Atoi(parts[0]); err == nil && len(parts) == 2 {
			c.SetTab(Tab(n))
			c.Submit(parts[1])
		}
	}
	return ""
}

func (c *Controller) homeTilesLocked() []Tile {
	host := c.d.Settings.IlariaURL
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	gpu := "GPU pentru Ilaria"
	if c.compute != nil && len(c.compute.GPUs) > 0 {
		gpu = c.compute.GPUs[0].Name
	}
	return []Tile{
		{Title: "Ilaria", Subtitle: "Asistent", Icon: "chat", Tone: "violet", Action: "chat:open", Category: "Ilaria"},
		{Title: "Agent", Subtitle: "Lucrează cu aprobarea ta", Icon: "terminal", Tone: "rose", Action: "tab:2", Category: "Ilaria"},
		{Title: "Căutare", Subtitle: fmt.Sprintf("%d documente indexate", c.d.Search.Count()), Icon: "search", Tone: "cyan", Action: "tab:3", Category: "Workspace"},
		{Title: "Fișiere", Subtitle: filepath.Base(c.d.Workspace), Icon: "folder", Tone: "amber", Action: "tab:4", Category: "Workspace"},
		{Title: "Calcul", Subtitle: gpu, Icon: "spark", Tone: "violet", Action: "tab:5", Category: "Sistem"},
		{Title: "Setări", Subtitle: host, Icon: "settings", Tone: "ink", Action: "tab:6", Category: "Sistem"},
		{Title: "Indexează", Subtitle: "Workspace-ul devine căutabil", Icon: "refresh", Tone: "cyan", Action: "run:3:/index", Category: "Workspace"},
		{Title: "Adaugă un site", Subtitle: "Crawl cu confirmare", Icon: "globe", Tone: "violet", Action: "fill:/crawl https://", Category: "Workspace"},
		{Title: "Testează Ilaria", Subtitle: "Verifică conexiunea", Icon: "link", Tone: "ink", Action: "run:6:/test", Category: "Sistem"},
		{Title: "Conversație nouă", Subtitle: "Începe de la zero", Icon: "spark", Tone: "rose", Action: "run:1:/new", Category: "Ilaria"},
	}
}

// Confirm accepts the visible prompt: an agent approval or a confirmation.
func (c *Controller) Confirm() { c.decide(true) }

// Reject declines the visible prompt.
func (c *Controller) Reject() { c.decide(false) }

func (c *Controller) decide(yes bool) {
	c.mu.Lock()
	if p := c.pending; p != nil {
		c.pending = nil
		if yes {
			p.run()
		} else {
			c.addLocked(c.tab, Block{Kind: KindInfo, Body: "Anulat."})
		}
		c.mu.Unlock()
		c.notify()
		return
	}
	c.mu.Unlock()
	if run := c.d.Agent.Snapshot(); run != nil && run.Approval != nil {
		if err := c.d.Agent.Decide(run.ID, run.Approval.ID, yes); err != nil {
			c.add(TabAgent, Block{Kind: KindError, Body: err.Error()})
		}
	}
	c.notify()
}

// Cancel stops the background task, a pending confirmation and the agent run.
func (c *Controller) Cancel() {
	c.mu.Lock()
	if c.cancel != nil {
		c.cancel()
	}
	c.pending = nil
	c.mu.Unlock()
	if run := c.d.Agent.Snapshot(); run != nil && (run.Status == "planning" || run.Status == "awaiting_approval" || run.Status == "executing" || run.Status == "interrupted") {
		_ = c.d.Agent.Cancel(run.ID)
	}
	c.notify()
}

// View returns the snapshot for the current tab.
func (c *Controller) View() View {
	run := c.d.Agent.Snapshot()
	c.mu.Lock()
	defer c.mu.Unlock()
	v := View{Tab: c.tab, Busy: c.busy, BusyLabel: c.busyLabel, Live: c.busy}
	v.ChatOpen = c.chatOpen || c.tab == TabChat
	if v.ChatOpen {
		v.Chat = cloneBlocks(c.logs[TabChat])
	}
	v.ChatBusy = c.busy && c.busyLabel == "Ilaria răspunde"
	host := c.d.Settings.IlariaURL
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	v.Connection = "Ilaria · " + host
	v.Status = fmt.Sprintf("Ilaria: %s · Index: %d documente · Workspace: %s", c.d.Settings.IlariaURL, c.d.Search.Count(), c.d.Workspace)
	switch c.tab {
	case TabHome:
		v.Eyebrow, v.Title, v.Subtitle = "UN ECOSISTEM. POSIBILITĂȚILE TALE.", "Universul tău Swypik", "Aplicațiile tale, workspace-ul tău, Ilaria. Împreună."
		v.Placeholder = "Întreab-o pe Ilaria sau mergi oriunde…"
		v.Tiles = c.homeTilesLocked()
		v.Blocks = cloneBlocks(c.logs[TabHome])
	case TabChat:
		v.Eyebrow, v.Title, v.Subtitle = "ILARIA · ASISTENT", "Conversație", "/new începe o conversație nouă."
		v.Placeholder = "Scrie un mesaj pentru Ilaria…"
		v.Empty = "Cu ce lucrăm astăzi?"
		v.Blocks = v.Chat
	case TabAgent:
		v.Eyebrow, v.Title, v.Subtitle = "AGENT · CU APROBAREA TA", "Agent", "Citește, editează și rulează în workspace. Fiecare pas îți cere aprobarea: F8 aprobă, F9 refuză."
		v.Placeholder = "Descrie ce trebuie făcut (de ex.: rulează testele și repară ce pică)…"
		v.Empty = "Ce construim astăzi?"
		v.Blocks = concatBlocks(runBlocks(run), c.logs[TabAgent])
		if run != nil && (run.Status == "planning" || run.Status == "executing" || run.Status == "awaiting_approval") {
			v.Live = true
		}
		if run != nil && run.Approval != nil {
			title, body := DescribeApproval(run.Approval.Tool, run.Approval.Arguments)
			v.Prompt = &Prompt{ID: run.Approval.ID, Approval: true, Title: title, Body: body, Confirm: "Aprobă (F8)", Reject: "Refuză (F9)"}
		}
	case TabSearch:
		v.Eyebrow, v.Title, v.Subtitle = "MOTORUL TĂU DE CĂUTARE", "Căutare", "Web și fișiere locale, într-un index care îți aparține. Fără Google, Bing sau DuckDuckGo."
		v.Placeholder = "Caută… (/index, /crawl URL)"
		// Results first; the latest notes (index/crawl reports) below them.
		v.Blocks = concatBlocks(c.results, c.logs[TabSearch])
	case TabFiles:
		v.Eyebrow, v.Title, v.Subtitle = "WORKSPACE", "Fișiere", c.d.Workspace
		v.Placeholder = "Deschide o cale relativă sau .. pentru dosarul părinte"
		v.Blocks = concatBlocks(c.filesBlocksLocked(), c.logs[TabFiles])
	case TabCompute:
		v.Eyebrow, v.Title, v.Subtitle = "CALCUL · ILARIA", "Calcul", "GPU-urile acestui dispozitiv și contribuția ta la antrenarea Ilaria."
		v.Placeholder = "/on, /off, /coordinator URL, /refresh"
		v.Blocks = concatBlocks(c.computeBlocksLocked(), c.logs[TabCompute])
	case TabSettings:
		v.Eyebrow, v.Title, v.Subtitle = "SISTEM", "Setări", "Serviciul Ilaria, workspace-ul și indexul."
		v.Placeholder = "/ilaria https://…, /test, /workspace DOSAR"
		v.Blocks = concatBlocks(c.settingsBlocksLocked(), c.logs[TabSettings])
	}
	if c.pending != nil {
		p := c.pending.prompt
		v.Prompt = &p
	}
	return v
}

func cloneBlocks(in []Block) []Block {
	if len(in) == 0 {
		return nil
	}
	out := make([]Block, len(in))
	copy(out, in)
	return out
}

func concatBlocks(a, b []Block) []Block {
	if len(a) == 0 {
		return cloneBlocks(b)
	}
	if len(b) == 0 {
		return cloneBlocks(a)
	}
	out := make([]Block, 0, len(a)+len(b))
	out = append(out, a...)
	out = append(out, b...)
	return out
}

// runBlocks renders an agent run as a transcript.
func runBlocks(r *agent.Run) []Block {
	if r == nil {
		return nil
	}
	blocks := []Block{{Kind: KindUser, Body: r.Goal}}
	for _, o := range r.Observations {
		title, _ := DescribeApproval(o.Tool, o.Arguments)
		blocks = append(blocks, Block{Kind: KindTool, Title: "✓ " + title, Body: summarizeOutput(o.Output)})
	}
	switch r.Status {
	case "planning":
		blocks = append(blocks, Block{Kind: KindInfo, Body: "Ilaria planifică următorul pas…"})
	case "executing":
		blocks = append(blocks, Block{Kind: KindInfo, Body: "Se execută pasul aprobat…"})
	case "awaiting_approval":
		blocks = append(blocks, Block{Kind: KindInfo, Body: "Aștept aprobarea ta pentru pasul de mai jos."})
	case "completed":
		blocks = append(blocks, Block{Kind: KindAssistant, Title: "Ilaria", Body: r.Summary})
	case "failed":
		blocks = append(blocks, Block{Kind: KindError, Title: "Rularea a eșuat", Body: r.Error})
	case "cancelled":
		blocks = append(blocks, Block{Kind: KindInfo, Body: "Rulare oprită. Efectele pașilor deja executați nu sunt anulate."})
	case "interrupted":
		hint := "Scrie /resume pentru a relua; fiecare pas va cere din nou aprobare."
		if r.Recovery == "uncertain" {
			hint = "Un pas poate să fi rulat fără rezultat salvat; reluarea automată este blocată. Verifică manual workspace-ul."
		}
		blocks = append(blocks, Block{Kind: KindInfo, Title: "Rulare întreruptă", Body: hint})
	}
	return blocks
}

func summarizeOutput(raw json.RawMessage) string {
	var v map[string]interface{}
	if json.Unmarshal(raw, &v) == nil {
		if created, ok := v["created"].(bool); ok {
			verb := "Fișier actualizat"
			if created {
				verb = "Fișier creat"
			}
			return fmt.Sprintf("%s · %v bytes", verb, v["bytes"])
		}
		if line, ok := v["line"].(float64); ok {
			return fmt.Sprintf("Editat la linia %d", int(line))
		}
		for _, key := range []string{"output", "content"} {
			if s, ok := v[key].(string); ok {
				return clipText(s, 1500)
			}
		}
	}
	return clipText(string(raw), 1500)
}

func clipText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n] + "\n…"
}

func clipLines(s string, max int) string {
	lines := strings.Split(s, "\n")
	if len(lines) <= max {
		return s
	}
	return strings.Join(lines[:max], "\n") + fmt.Sprintf("\n… (+%d linii)", len(lines)-max)
}

const (
	maxApprovalContentPreviewLines = 40
	maxApprovalDiffPreviewLines    = 20
	maxApprovalGenericTextBytes    = 1500
)

// DescribeApproval turns a tool call into a human title and preview.
func DescribeApproval(tool string, raw json.RawMessage) (string, string) {
	switch tool {
	case "workspace.read":
		var a agent.ReadArgs
		_ = json.Unmarshal(raw, &a)
		return "Citește " + a.Path, ""
	case "workspace.list":
		var a agent.ListArgs
		_ = json.Unmarshal(raw, &a)
		p := a.Path
		if p == "" {
			p = "."
		}
		return "Listează " + p, ""
	case "workspace.write":
		var a agent.WriteArgs
		_ = json.Unmarshal(raw, &a)
		title := "Suprascrie " + a.Path
		if a.ExpectedSHA256 == "" {
			title = "Creează " + a.Path
		}
		return title, clipLines(a.Content, maxApprovalContentPreviewLines)
	case "workspace.edit":
		var a agent.EditArgs
		_ = json.Unmarshal(raw, &a)
		var b strings.Builder
		for _, l := range strings.Split(clipLines(a.Old, maxApprovalDiffPreviewLines), "\n") {
			b.WriteString("- " + l + "\n")
		}
		for _, l := range strings.Split(clipLines(a.New, maxApprovalDiffPreviewLines), "\n") {
			b.WriteString("+ " + l + "\n")
		}
		return "Editează " + a.Path, strings.TrimRight(b.String(), "\n")
	case "process.run":
		var a agent.RunArgs
		_ = json.Unmarshal(raw, &a)
		return "Rulează o comandă în workspace", a.Command
	case "search.query":
		var a agent.SearchArgs
		_ = json.Unmarshal(raw, &a)
		return "Caută în index: " + a.Query, ""
	case "network.interfaces":
		return "Citește adaptoarele de rețea", ""
	}
	var a map[string]interface{}
	_ = json.Unmarshal(raw, &a)
	pretty, _ := json.MarshalIndent(a, "", "  ")
	return tool, clipText(string(pretty), maxApprovalGenericTextBytes)
}
