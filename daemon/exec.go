// Commands started in the background: each one gets an id, runs on its own, and its state and output can be read at any
// time, while it runs or after it ended, and followed as it lands.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

// One sub-folder per command, with its stdout and stderr as plain files the agent can read too.
const outputDir = "/tmp/parpaing"

// The most raw bytes one output line carries: a client never has to hold more than this to decode a line.
const lineMax = 64 * 1024

// After its main process exits, a command's output counts as finished once both pipes end, or after this delay: children
// left in the background must not keep a follow open forever.
const linger = 200 * time.Millisecond

// A follow with nothing to send closes after this delay with {"next"}: proxies and Node fetch cut connections that stay
// silent, while a clean close tells the client where to reconnect.
const idle = 50 * time.Second

// Between SIGTERM and SIGKILL on stop: time for the command to clean up.
const grace = 10 * time.Second

// Once the current generation of a command's output files holds this much (both streams), the next write starts a new
// one. Two are kept: at least the last 50 MiB of a command, at most about 100 MiB. A var for the tests.
var segment int64 = 50 << 20

// Finished commands kept: past it, a start removes the oldest, output included. A var for the tests.
var keep = 50

// One of a command's two output streams, also the index of its file in a generation.
type stream int

const (
	stdout stream = iota
	stderr
)

// Both streams, for the loops over them.
var streams = [...]stream{stdout, stderr}

// The name clients get, also the name of its file: "stdout" or "stderr".
func (s stream) String() string {
	return [...]string{"stdout", "stderr"}[s]
}

// Where a command is in its life, always in this order.
type phase int

const (
	running  phase = iota // its main process runs
	exited                // the main process ended, its last output may still come
	finished              // the output is complete
	evicted               // removed by the cap of finished commands
)

// One run of output of one stream, in the order it arrived: its generation, offset in that generation's file, and at in
// the merged output of both streams. A chunk never cuts a UTF-8 character, so every chunk boundary is a character boundary.
type chunk struct {
	stream           stream
	gen              *generation
	offset, size, at int64
}

// A command's output files, both streams rotated together: the current generation is stdout and stderr, the previous
// one stdout.1 and stderr.1. start is the merged position of its first byte.
type generation struct {
	// Kept open: the daemon reads its own descriptors, so a file deleted from inside the sandbox stays readable here.
	files [2]*os.File
	sizes [2]int64
	start int64
}

type command struct {
	id  string
	cmd []string
	pid int
	dir string
	mu  sync.Mutex
	// Oldest first, at most 2: the previous generation, then the current one.
	gens   []*generation
	total  int64
	chunks []chunk
	phase  phase
	code   int
	eofs   int
	late   bool
	// Closed and replaced on every change: a follower waits on it together with its client, without polling.
	changed chan struct{}
}

// The sandbox's commands, and the HTTP routes on them as methods. mu is held while a command starts and while the reaper
// collects: a command that ends at once is already in byPid when its status is collected, never handed to the orphans.
// Lock order: the table's mu, then a command's mu.
type table struct {
	mu       sync.Mutex
	commands map[string]*command
	order    []*command
	byPid    map[int]*command
}

func newTable() *table {
	return &table{commands: map[string]*command{}, byPid: map[int]*command{}}
}

func answer(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func (t *table) find(w http.ResponseWriter, r *http.Request) *command {
	t.mu.Lock()
	c := t.commands[r.PathValue("id")]
	t.mu.Unlock()
	if c == nil {
		answer(w, http.StatusNotFound, map[string]string{"error": "unknown command"})
	}
	return c
}

// POST /commands {"cmd": [...]}: starts the command and answers its id at once.
func (t *table) start(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Cmd []string `json:"cmd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Cmd) == 0 {
		answer(w, http.StatusBadRequest, map[string]string{"error": `cmd: a command as an array, for example ["ls", "-la"]`})
		return
	}
	c, status, err := t.run(body.Cmd)
	if err != nil {
		answer(w, status, map[string]string{"error": err.Error()})
		return
	}
	answer(w, http.StatusCreated, map[string]string{"id": c.id})
}

// Starts a command and adds it to the table.
func (t *table) run(args []string) (*command, int, error) {
	raw := make([]byte, 6)
	rand.Read(raw)
	c := &command{id: hex.EncodeToString(raw), cmd: args, changed: make(chan struct{})}
	c.dir = filepath.Join(outputDir, c.id)
	// Read and write ends of the stdout pipe, then of the stderr pipe.
	var pipes [4]*os.File
	failed := func(status int, err error) (*command, int, error) {
		for _, f := range pipes {
			if f != nil {
				f.Close()
			}
		}
		for _, g := range c.gens {
			g.close()
		}
		os.RemoveAll(c.dir)
		return nil, status, err
	}

	g, err := newGeneration(c.dir, 0)
	if err != nil {
		return failed(http.StatusInternalServerError, err)
	}
	c.gens = []*generation{g}
	for _, s := range streams {
		if pipes[2*s], pipes[2*s+1], err = os.Pipe(); err != nil {
			return failed(http.StatusInternalServerError, err)
		}
	}

	cmd := exec.Command(args[0], args[1:]...)
	// Inherited by everything the command starts: stop finds the processes that left the group by it.
	cmd.Env = append(os.Environ(), "PARPAING_EXEC="+c.id)
	cmd.Stdout, cmd.Stderr = pipes[1], pipes[3]
	// Its own process group: the command and what it starts can be told apart from the rest, and stopped together.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	t.mu.Lock()
	if err := cmd.Start(); err != nil {
		t.mu.Unlock()
		return failed(http.StatusBadRequest, err)
	}
	t.evict()
	c.pid = cmd.Process.Pid
	t.commands[c.id] = c
	t.order = append(t.order, c)
	t.byPid[c.pid] = c
	// The reaper collects it, not Wait: Release only frees the handle Go keeps on the process.
	cmd.Process.Release()
	t.mu.Unlock()

	// Only the command holds the write ends now: the pipes end when it and its children close them.
	pipes[1].Close()
	pipes[3].Close()
	go c.copy(stdout, pipes[0])
	go c.copy(stderr, pipes[2])
	return c, http.StatusCreated, nil
}

// Called with t.mu held, at each start: past keep finished commands, the oldest go, output files included. Their readers
// end with {"next"}, and the next request gets 404. A new order slice: list may still read the old one.
func (t *table) evict() {
	var done []*command
	for _, c := range t.order {
		c.mu.Lock()
		if c.phase == finished {
			done = append(done, c)
		}
		c.mu.Unlock()
	}
	if len(done) <= keep {
		return
	}
	for _, c := range done[:len(done)-keep] {
		delete(t.commands, c.id)
		c.mu.Lock()
		c.phase = evicted
		for _, g := range c.gens {
			g.close()
		}
		c.notify()
		c.mu.Unlock()
		os.RemoveAll(c.dir)
	}
	t.order = slices.DeleteFunc(slices.Clone(t.order), func(c *command) bool { return t.commands[c.id] == nil })
}

// New stdout and stderr in dir, for a generation starting at merged position start. Whatever the agent left at those
// names goes first, and the folder comes back if it removed it.
func newGeneration(dir string, start int64) (*generation, error) {
	os.MkdirAll(dir, 0o755)
	g := &generation{start: start}
	for _, s := range streams {
		path := filepath.Join(dir, s.String())
		os.Remove(path)
		f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o644)
		if err != nil {
			g.close()
			return nil, err
		}
		g.files[s] = f
	}
	return g, nil
}

func (g *generation) close() {
	for _, f := range g.files {
		if f != nil {
			f.Close()
		}
	}
}

// Called with c.mu held, when the current generation is full: the previous one goes, the current one becomes stdout.1
// and stderr.1 (its open files stay valid), and new files take the names. If they cannot be created (only the agent can
// cause it, by breaking its own folder), writing goes on in the current generation and the next write tries again.
func (c *command) rotate() {
	if len(c.gens) == 2 {
		old := c.gens[0]
		old.close()
		for _, s := range streams {
			os.Remove(filepath.Join(c.dir, s.String()+".1"))
		}
		c.gens = c.gens[1:]
		// Its chunks lead the index.
		c.chunks = slices.Delete(c.chunks, 0, sort.Search(len(c.chunks), func(i int) bool { return c.chunks[i].gen != old }))
	}
	for _, s := range streams {
		os.Rename(filepath.Join(c.dir, s.String()), filepath.Join(c.dir, s.String()+".1"))
	}
	if g, err := newGeneration(c.dir, c.total); err == nil {
		c.gens = append(c.gens, g)
	}
}

// Copies one output pipe into its file. The end of an incomplete character waits for the next read, so a chunk never cuts
// one; at the end of the pipe whatever is left goes as it is.
func (c *command) copy(s stream, from *os.File) {
	defer from.Close()
	buf := make([]byte, 32*1024)
	held := 0
	for {
		n, err := from.Read(buf[held:])
		n += held
		cut := n
		if err == nil {
			cut = complete(buf[:n])
		}
		c.write(s, buf[:cut])
		held = copy(buf, buf[cut:n])
		if err != nil {
			c.mu.Lock()
			c.eofs++
			c.check()
			c.mu.Unlock()
			return
		}
	}
}

// Writes and records each piece under c.mu: a reader never asks for bytes not written yet, nor reads a file a rotation
// closed.
func (c *command) write(s stream, b []byte) {
	if len(b) == 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	// Children left behind may still write after an eviction: their output goes nowhere.
	if c.phase == evicted {
		return
	}
	if g := c.gens[len(c.gens)-1]; c.total-g.start >= segment {
		c.rotate()
	}
	g := c.gens[len(c.gens)-1]
	written, _ := g.files[s].Write(b)
	if written == 0 {
		return
	}
	n := int64(written)
	// The same stream right after the last chunk, in the same file: the chunk grows, so the index only grows when the
	// stream changes.
	if last := len(c.chunks) - 1; last >= 0 && c.chunks[last].stream == s && c.chunks[last].gen == g {
		c.chunks[last].size += n
	} else {
		c.chunks = append(c.chunks, chunk{s, g, g.sizes[s], n, c.total})
	}
	g.sizes[s] += n
	c.total += n
	c.notify()
}

// The length of b without a last character still incomplete (at most 3 bytes). Invalid bytes count as complete.
func complete(b []byte) int {
	for i := len(b) - 1; i >= 0 && i > len(b)-utf8.UTFMax; i-- {
		if utf8.RuneStart(b[i]) {
			if !utf8.FullRune(b[i:]) {
				return i
			}
			break
		}
	}
	return len(b)
}

// The command's main process ended. Children left in the background may still write: their output keeps landing.
func (c *command) finish(status syscall.WaitStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.phase = exited
	c.code = status.ExitStatus()
	if status.Signaled() {
		c.code = 128 + int(status.Signal())
	}
	// Only the command's mu here: the reaper holds the table's mu when it calls finish, never the timer.
	time.AfterFunc(linger, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.late = true
		c.check()
	})
	c.check()
}

// Called with c.mu held, at each event that can finish the output: exit, end of a pipe, linger over.
func (c *command) check() {
	if c.phase == exited && (c.eofs == 2 || c.late) {
		c.phase = finished
		c.notify()
	}
}

// Called with c.mu held: wakes every follower.
func (c *command) notify() {
	close(c.changed)
	c.changed = make(chan struct{})
}

func (c *command) state(withSize bool) map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := map[string]any{"id": c.id, "cmd": c.cmd, "state": "running", "exitCode": nil}
	if c.phase >= exited {
		s["state"], s["exitCode"] = "exited", c.code
	}
	if withSize {
		s["outputSize"] = c.total
	}
	return s
}

// GET /commands: every command, in start order.
func (t *table) list(w http.ResponseWriter, _ *http.Request) {
	t.mu.Lock()
	all := t.order
	t.mu.Unlock()
	list := make([]map[string]any, 0, len(all))
	for _, c := range all {
		list = append(list, c.state(false))
	}
	answer(w, http.StatusOK, list)
}

// GET /commands/{id}: the state at once, even while the command runs.
func (t *table) read(w http.ResponseWriter, r *http.Request) {
	if c := t.find(w, r); c != nil {
		answer(w, http.StatusOK, c.state(true))
	}
}

// GET /commands/{id}/output?from=N&follow=true|false: the merged output from byte N, one JSON line per piece, each with
// the position to resume from. A position before the kept output gets {"skipped", "next"} first: the bytes lost, and
// where the kept output starts. Every answer ends with one closing line, so the client knows why it ended and where to
// resume: {"exitCode", "next"} once the output is finished, else {"next"}.
func (t *table) output(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	from, follow := int64(0), false
	if v := q.Get("from"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			answer(w, http.StatusBadRequest, map[string]string{"error": "from: a byte position, 0 or more"})
			return
		}
		from = n
	}
	switch q.Get("follow") {
	case "", "false":
	case "true":
		follow = true
	default:
		answer(w, http.StatusBadRequest, map[string]string{"error": "follow: true or false"})
		return
	}
	c := t.find(w, r)
	if c == nil {
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	send := func(line any) bool {
		if enc.Encode(line) != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}
	pos, rounded := from, from == 0
	silence := time.NewTimer(idle)
	defer silence.Stop()
	for {
		// One snapshot, wake channel included: a chunk landing after it closes that channel, so no wakeup is lost.
		c.mu.Lock()
		total, done, code, changed := c.total, c.phase >= finished, c.code, c.changed
		c.mu.Unlock()
		for pos < total {
			// Each line is read under c.mu, since a rotation or an eviction closes files, and sent once it is released: a
			// slow client never holds the command up.
			c.mu.Lock()
			gone, kept := c.phase == evicted, c.gens[0].start
			var s stream
			var data []byte
			if !gone && pos >= kept {
				s, data = c.line(pos)
			}
			c.mu.Unlock()
			if gone {
				send(map[string]int64{"next": pos})
				return
			}
			if pos < kept {
				// What came before the oldest kept generation is gone: how much, then the rest from its start, a chunk start
				// and so a character boundary.
				skipped := kept - pos
				pos, rounded = kept, true
				if !send(map[string]int64{"skipped": skipped, "next": pos}) {
					return
				}
				silence.Reset(idle)
				continue
			}
			if !rounded {
				// A position inside a character starts at the next one.
				rounded = true
				k := charStart(data)
				pos += int64(k)
				data = data[k:]
				if len(data) == 0 {
					// The skip used the whole line: what follows starts a new one.
					continue
				}
			}
			if len(data) == 0 {
				break
			}
			pos += int64(len(data))
			if !send(map[string]any{"stream": s.String(), "data": string(data), "next": pos}) {
				return
			}
			silence.Reset(idle)
		}
		if done {
			send(map[string]int64{"exitCode": int64(code), "next": total})
			return
		}
		if !follow {
			send(map[string]int64{"next": pos})
			return
		}
		select {
		case <-changed:
		case <-silence.C:
			send(map[string]int64{"next": pos})
			return
		case <-r.Context().Done():
			return
		}
	}
}

// Called with c.mu held, pos in the kept output: the output line starting at merged position pos, from the one chunk
// holding it, up to lineMax bytes, cut on a character boundary. Nothing when pos is at or past the end.
func (c *command) line(pos int64) (stream, []byte) {
	i := sort.Search(len(c.chunks), func(i int) bool { return c.chunks[i].at+c.chunks[i].size > pos })
	if i == len(c.chunks) {
		return stdout, nil
	}
	ch := c.chunks[i]
	end := ch.at + ch.size
	buf := make([]byte, min(end-pos, lineMax))
	n, _ := ch.gen.files[ch.stream].ReadAt(buf, ch.offset+pos-ch.at)
	buf = buf[:n]
	if pos+int64(n) < end {
		buf = buf[:complete(buf)]
	}
	return ch.stream, buf
}

// How many bytes at the start of b belong to a character begun before it (at most 3).
func charStart(b []byte) int {
	k := 0
	for k < len(b) && k < utf8.UTFMax-1 && !utf8.RuneStart(b[k]) {
		k++
	}
	return k
}

// POST /commands/{id}/stop: answers at once, then SIGTERM, and SIGKILL after the grace delay.
func (t *table) stop(w http.ResponseWriter, r *http.Request) {
	c := t.find(w, r)
	if c == nil {
		return
	}
	answer(w, http.StatusAccepted, struct{}{})
	go func() {
		c.signal(syscall.SIGTERM)
		time.Sleep(grace)
		c.signal(syscall.SIGKILL)
	}()
}

// Signals the command's process group, and every process still carrying its PARPAING_EXEC entry: those that left the
// group. Rescanned on each call, so SIGKILL also reaches what started during the grace delay. Errors (gone, not ours) are
// ignored.
func (c *command) signal(sig syscall.Signal) {
	syscall.Kill(-c.pid, sig)
	want := "PARPAING_EXEC=" + c.id
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		env, err := os.ReadFile("/proc/" + e.Name() + "/environ")
		if err != nil {
			continue
		}
		for _, entry := range strings.Split(string(env), "\x00") {
			if entry == want {
				syscall.Kill(pid, sig)
				break
			}
		}
	}
}
