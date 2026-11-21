package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"
)

func TestComplete(t *testing.T) {
	e := "é" // 2 bytes
	z := "€" // 3 bytes
	g := "😀" // 4 bytes
	for _, tc := range []struct {
		in   string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"a" + e, 3},
		{"a" + e[:1], 1},
		{"a" + z[:2], 1},
		{"a" + g[:3], 1},
		{"a" + g, 5},
		{"a\xff", 2},
		{"a\x80\x80", 3},
	} {
		if got := complete([]byte(tc.in)); got != tc.want {
			t.Errorf("complete(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestCharStart(t *testing.T) {
	g := "😀"
	for _, tc := range []struct {
		in   string
		want int
	}{
		{"abc", 0},
		{g[1:] + "x", 3},
		{g[2:] + "x", 2},
		{"é"[1:] + "x", 1},
		{"\x80\x80\x80\x80", 3},
	} {
		if got := charStart([]byte(tc.in)); got != tc.want {
			t.Errorf("charStart(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

type piece = struct {
	stream stream
	text   string
}

// Reads every line from pos to the end, the way output does.
func lines(c *command, pos int64) (out []piece, nexts []int64) {
	for {
		s, data := c.line(pos)
		if len(data) == 0 {
			return
		}
		pos += int64(len(data))
		out = append(out, piece{s, string(data)})
		nexts = append(nexts, pos)
	}
}

func TestLineSplitsOnCharacters(t *testing.T) {
	cmds := newTable()
	// One run of 140000 bytes over several chunks of one stream, then stderr.
	text := strings.Repeat("é", 70000)
	c := fake(t, cmds, "bbbbbbbbbbb1", piece{stdout, text[:30000]}, piece{stdout, text[30000:100000]}, piece{stdout, text[100000:]}, piece{stderr, "err\n"})
	got, nexts := lines(c, 0)
	var joined strings.Builder
	for i, l := range got[:len(got)-1] {
		if l.stream != stdout || len(l.text) > lineMax || !utf8.ValidString(l.text) {
			t.Fatalf("line %d: stream %d, %d bytes, valid %v", i, l.stream, len(l.text), utf8.ValidString(l.text))
		}
		joined.WriteString(l.text)
	}
	if joined.String() != text {
		t.Fatal("stdout lines do not join back to the input")
	}
	if len(got[0].text) != lineMax {
		t.Errorf("first line is %d bytes, want %d", len(got[0].text), lineMax)
	}
	last := got[len(got)-1]
	if last != (piece{stderr, "err\n"}) || nexts[len(nexts)-1] != 140004 {
		t.Errorf("last line %v next %d", last, nexts[len(nexts)-1])
	}
	// A line ends inside a 65536 byte read only on a character boundary: 65536 is even, so é fits exactly.
	if nexts[0] != lineMax {
		t.Errorf("first next %d", nexts[0])
	}
}

func TestLineOddCap(t *testing.T) {
	cmds := newTable()
	// "a" then é: the 65536th byte is the first half of an é, so the line stops one byte short.
	text := "a" + strings.Repeat("é", 40000)
	got, nexts := lines(fake(t, cmds, "bbbbbbbbbbb2", piece{stdout, text}), 0)
	if len(got) != 2 || len(got[0].text) != lineMax-1 || nexts[0] != lineMax-1 || nexts[1] != int64(len(text)) {
		t.Fatalf("lines %d, first %d bytes, nexts %v", len(got), len(got[0].text), nexts)
	}
}

func TestLineNextAndFrom(t *testing.T) {
	cmds := newTable()
	c := fake(t, cmds, "bbbbbbbbbbb3", piece{stdout, "out\n"}, piece{stderr, "err\n"}, piece{stdout, "é\n"})
	got, nexts := lines(c, 0)
	want := []piece{{0, "out\n"}, {1, "err\n"}, {0, "é\n"}}
	if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("lines %v", got)
	}
	if nexts[0] != 4 || nexts[1] != 8 || nexts[2] != 11 {
		t.Fatalf("nexts %v", nexts)
	}
	// Resuming from a next gives only what follows.
	if got, _ := lines(c, 4); len(got) != 2 || got[0] != want[1] {
		t.Fatalf("from 4: %v", got)
	}
	// From inside a chunk, and inside a character: the reader skips to the next character.
	_, data := c.line(9)
	if k := charStart(data); string(data[k:]) != "\n" {
		t.Fatalf("from 9: %q skip %d", data, k)
	}
	if _, data := c.line(11); len(data) != 0 {
		t.Fatalf("from the end: %q", data)
	}
	if _, data := c.line(50); len(data) != 0 {
		t.Fatalf("past the end: %q", data)
	}
}

// A command already in the table, in its own folder, with its output written as the copy would, for the handler tests.
func fake(t *testing.T, cmds *table, id string, pieces ...piece) *command {
	c := &command{id: id, cmd: []string{"x"}, dir: filepath.Join(t.TempDir(), id), changed: make(chan struct{})}
	g, err := newGeneration(c.dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	c.gens = []*generation{g}
	t.Cleanup(func() {
		for _, g := range c.gens {
			g.close()
		}
	})
	for _, p := range pieces {
		c.write(p.stream, []byte(p.text))
	}
	cmds.mu.Lock()
	cmds.commands[id] = c
	cmds.mu.Unlock()
	return c
}

// The answer of GET /commands/{id}/output?query, one decoded object per line.
func get(t *testing.T, cmds *table, id, query string) (int, []map[string]any) {
	r := httptest.NewRequest("GET", "/commands/"+id+"/output?"+query, nil)
	r.SetPathValue("id", id)
	w := httptest.NewRecorder()
	cmds.output(w, r)
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSuffix(w.Body.String(), "\n"), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("line %q: %v", l, err)
		}
		out = append(out, m)
	}
	return w.Code, out
}

func TestOutputClosingLine(t *testing.T) {
	cmds := newTable()
	c := fake(t, cmds, "aaaaaaaaaaa1", piece{stdout, "out\n"}, piece{stderr, "err\n"})
	// Running, caught up: the last line says where to resume.
	if _, out := get(t, cmds, c.id, ""); len(out) != 3 || fmt.Sprint(out[2]) != "map[next:8]" {
		t.Fatalf("running: %v", out)
	}
	if _, out := get(t, cmds, c.id, "from=50"); len(out) != 1 || fmt.Sprint(out[0]) != "map[next:50]" {
		t.Fatalf("running, past the end: %v", out)
	}
	// Finished: exit code and the end.
	c.mu.Lock()
	c.phase, c.code, c.eofs = exited, 3, 2
	c.check()
	c.mu.Unlock()
	if _, out := get(t, cmds, c.id, "from=4"); len(out) != 2 || fmt.Sprint(out[1]) != "map[exitCode:3 next:8]" {
		t.Fatalf("finished: %v", out)
	}
	// follow on a finished command ends at once the same way.
	if _, out := get(t, cmds, c.id, "follow=true"); len(out) != 3 || fmt.Sprint(out[2]) != "map[exitCode:3 next:8]" {
		t.Fatalf("finished, follow: %v", out)
	}
}

func TestOutputFromInsideCharacter(t *testing.T) {
	cmds := newTable()
	// é alone in its chunk, then stderr: from=1 skips the half character and still sends what follows.
	c := fake(t, cmds, "aaaaaaaaaaa2", piece{stdout, "é"}, piece{stderr, "x"})
	_, out := get(t, cmds, c.id, "from=1")
	if len(out) != 2 || fmt.Sprint(out[0]) != "map[data:x next:3 stream:stderr]" || fmt.Sprint(out[1]) != "map[next:3]" {
		t.Fatalf("from=1: %v", out)
	}
	// Nothing after the skip: the closing next is the rounded from.
	c = fake(t, cmds, "aaaaaaaaaaa3", piece{stdout, "é"})
	if _, out := get(t, cmds, c.id, "from=1"); len(out) != 1 || fmt.Sprint(out[0]) != "map[next:2]" {
		t.Fatalf("from=1 at the end: %v", out)
	}
}

func TestOutputBadQuery(t *testing.T) {
	cmds := newTable()
	fake(t, cmds, "aaaaaaaaaaa4")
	for _, q := range []string{"from=-1", "from=x", "follow=yes"} {
		if code, _ := get(t, cmds, "aaaaaaaaaaa4", q); code != 400 {
			t.Errorf("%s: %d", q, code)
		}
	}
	if code, _ := get(t, cmds, "000000000000", ""); code != 404 {
		t.Errorf("unknown: %d", code)
	}
}

// Lowers segment for one test.
func small(t *testing.T, n int64) {
	old := segment
	segment = n
	t.Cleanup(func() { segment = old })
}

func TestRotation(t *testing.T) {
	cmds := newTable()
	small(t, 10)
	// Three generations: 0 to 10, 10 to 20, 20 to 23. The first one goes with its files.
	c := fake(t, cmds, "ccccccccccc1", piece{stdout, "0123456789"}, piece{stderr, "abc"}, piece{stdout, "defghij"}, piece{stdout, "XYZ"})
	for name, want := range map[string]string{"stdout": "XYZ", "stderr": "", "stdout.1": "defghij", "stderr.1": "abc"} {
		if got, err := os.ReadFile(filepath.Join(c.dir, name)); err != nil || string(got) != want {
			t.Errorf("%s: %q %v", name, got, err)
		}
	}
	if entries, _ := os.ReadDir(c.dir); len(entries) != 4 {
		t.Errorf("%d files in the folder", len(entries))
	}
	if len(c.gens) != 2 || c.gens[0].start != 10 || len(c.chunks) != 3 || c.total != 23 {
		t.Fatalf("%d generations from %d, %d chunks, total %d", len(c.gens), c.gens[0].start, len(c.chunks), c.total)
	}
	// From 0: what is gone, then the kept output in order. Same stream, other generation: another line.
	_, out := get(t, cmds, c.id, "")
	if fmt.Sprint(out) != "[map[next:10 skipped:10] map[data:abc next:13 stream:stderr] map[data:defghij next:20 stream:stdout] map[data:XYZ next:23 stream:stdout] map[next:23]]" {
		t.Fatalf("from 0: %v", out)
	}
	if _, out := get(t, cmds, c.id, "from=5"); fmt.Sprint(out[0]) != "map[next:10 skipped:5]" {
		t.Fatalf("from 5: %v", out)
	}
	if _, out := get(t, cmds, c.id, "from=12"); fmt.Sprint(out[0]) != "map[data:c next:13 stream:stderr]" {
		t.Fatalf("from 12: %v", out)
	}
}

func TestRotationRetries(t *testing.T) {
	cmds := newTable()
	small(t, 4)
	c := fake(t, cmds, "ccccccccccc2", piece{stdout, "aaaa"})
	// The agent puts a file where the folder was: no new generation, writing goes on in the current one.
	os.RemoveAll(c.dir)
	os.WriteFile(c.dir, nil, 0o644)
	c.write(stdout, []byte("bb"))
	if len(c.gens) != 1 || c.total != 6 {
		t.Fatalf("%d generations, total %d", len(c.gens), c.total)
	}
	// The next write tries again, and brings the folder back.
	os.Remove(c.dir)
	c.write(stderr, []byte("cc"))
	if len(c.gens) != 2 || c.gens[1].start != 6 {
		t.Fatalf("%d generations", len(c.gens))
	}
	if got, _ := os.ReadFile(filepath.Join(c.dir, "stderr")); string(got) != "cc" {
		t.Errorf("stderr: %q", got)
	}
	if _, out := get(t, cmds, c.id, ""); fmt.Sprint(out) != "[map[data:aaaabb next:6 stream:stdout] map[data:cc next:8 stream:stderr] map[next:8]]" {
		t.Fatalf("output: %v", out)
	}
}

// Runs f while the daemon can neither remove nor rename anything in c's folder: read-only, the way an agent of the same
// uid can leave it on a non-root image. As root the test acts as nobody meanwhile, since root ignores the mode.
func readOnly(t *testing.T, c *command, f func()) {
	// t.TempDir is 0700: nobody must reach the folder.
	os.Chmod(filepath.Dir(filepath.Dir(c.dir)), 0o755)
	os.Chmod(c.dir, 0o555)
	defer os.Chmod(c.dir, 0o755)
	if os.Geteuid() == 0 {
		if err := syscall.Setresuid(-1, 65534, -1); err != nil {
			t.Fatal(err)
		}
		defer syscall.Setresuid(-1, 0, -1)
	}
	f()
}

func TestRotationSkipsFifo(t *testing.T) {
	cmds := newTable()
	small(t, 4)
	c := fake(t, cmds, "ccccccccccc6", piece{stdout, "aaaa"})
	// The agent puts a FIFO at stdout: written to, it would block once the pipe is full, c.mu held.
	path := filepath.Join(c.dir, "stdout")
	os.Remove(path)
	if err := syscall.Mkfifo(path, 0o666); err != nil {
		t.Fatal(err)
	}
	os.Chmod(path, 0o666)
	// stderr open to nobody too: only the FIFO itself must stop the new generation.
	os.Chmod(filepath.Join(c.dir, "stderr"), 0o666)
	big := []byte(strings.Repeat("b", 256*1024))
	readOnly(t, c, func() {
		done := make(chan struct{})
		go func() {
			c.write(stdout, big)
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("the write blocks on the FIFO")
		}
	})
	// No new generation: writing went on in the current one, a regular file.
	if info, err := c.gens[0].files[stdout].Stat(); len(c.gens) != 1 || c.total != int64(4+len(big)) || err != nil || !info.Mode().IsRegular() {
		t.Fatalf("%d generations, total %d, %v %v", len(c.gens), c.total, info, err)
	}
}

func TestRotationSkipsSymlink(t *testing.T) {
	cmds := newTable()
	small(t, 4)
	c := fake(t, cmds, "ccccccccccc7", piece{stdout, "aaaa"})
	// The agent points stdout at a file it wants the daemon to overwrite.
	target := filepath.Join(filepath.Dir(c.dir), "target")
	os.WriteFile(target, []byte("keep"), 0o666)
	os.Chmod(target, 0o666)
	path := filepath.Join(c.dir, "stdout")
	os.Remove(path)
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	readOnly(t, c, func() { c.write(stdout, []byte("bb")) })
	if got, _ := os.ReadFile(target); string(got) != "keep" {
		t.Errorf("target: %q", got)
	}
	if len(c.gens) != 1 || c.total != 6 {
		t.Fatalf("%d generations, total %d", len(c.gens), c.total)
	}
}

func TestChunksMerge(t *testing.T) {
	cmds := newTable()
	c := fake(t, cmds, "ccccccccccc3")
	for range 1000 {
		c.write(stdout, []byte("a"))
	}
	c.write(stderr, []byte("b"))
	c.write(stdout, []byte("a"))
	if len(c.chunks) != 3 || c.chunks[0].size != 1000 || c.chunks[2].offset != 1000 {
		t.Fatalf("chunks %v", c.chunks)
	}
}

func TestChunkMax(t *testing.T) {
	old := chunkMax
	chunkMax = 3
	t.Cleanup(func() { chunkMax = old })
	cmds := newTable()
	c := fake(t, cmds, "ccccccccccc6")
	// Streams in turn on every write: one chunk per byte, a rotation every 3, the segment never reached.
	for i := range 10 {
		c.write(stream(i%2), []byte{byte('0' + i)})
		if len(c.chunks) > 2*chunkMax {
			t.Fatalf("write %d: %d chunks", i, len(c.chunks))
		}
	}
	if len(c.gens) != 2 || c.gens[0].start != 6 || len(c.chunks) != 4 {
		t.Fatalf("%d generations from %d, %d chunks", len(c.gens), c.gens[0].start, len(c.chunks))
	}
	_, out := get(t, cmds, c.id, "")
	if fmt.Sprint(out) != "[map[next:6 skipped:6] map[data:6 next:7 stream:stdout] map[data:7 next:8 stream:stderr] map[data:8 next:9 stream:stdout] map[data:9 next:10 stream:stderr] map[next:10]]" {
		t.Fatalf("from 0: %v", out)
	}
}

func TestStartBodyTooLarge(t *testing.T) {
	cmds := newTable()
	// A valid command, past the cap: without it, true would start.
	body := `{"cmd": ["true"], "x": "` + strings.Repeat("a", 1<<20) + `"}`
	w := httptest.NewRecorder()
	cmds.start(w, httptest.NewRequest("POST", "/commands", strings.NewReader(body)))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "the request body is over 1 MiB") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if len(cmds.order) != 0 {
		t.Fatalf("%d commands started", len(cmds.order))
	}
}

// A client that takes each line only when the test lets it: Write hands the line over, then waits.
type gate struct {
	lines chan string
	open  chan struct{}
}

func (g *gate) Header() http.Header { return http.Header{} }
func (g *gate) WriteHeader(int)     {}
func (g *gate) Write(b []byte) (int, error) {
	g.lines <- string(b)
	<-g.open
	return len(b), nil
}

// Reads a command's output through a gate, in the background.
func through(cmds *table, c *command, query string) *gate {
	g := &gate{make(chan string), make(chan struct{})}
	r := httptest.NewRequest("GET", "/commands/"+c.id+"/output?"+query, nil)
	r.SetPathValue("id", c.id)
	go cmds.output(g, r)
	return g
}

// Takes the next line through the gate and checks it.
func (g *gate) take(t *testing.T, want string) {
	t.Helper()
	if got := <-g.lines; got != want+"\n" {
		t.Fatalf("line %q, want %q", got, want)
	}
	g.open <- struct{}{}
}

func TestFollowerFallsBehind(t *testing.T) {
	cmds := newTable()
	small(t, 10)
	c := fake(t, cmds, "ccccccccccc4", piece{stdout, "aaaa"})
	g := through(cmds, c, "follow=true")
	got := <-g.lines
	// While it sends its first line, two rotations: what it had not read yet is gone.
	c.write(stdout, []byte("bbbbbb"))
	c.write(stderr, []byte("cccccccccc"))
	c.write(stdout, []byte("dd"))
	g.open <- struct{}{}
	if got != `{"data":"aaaa","next":4,"stream":"stdout"}`+"\n" {
		t.Fatalf("first line %q", got)
	}
	g.take(t, `{"next":10,"skipped":6}`)
	g.take(t, `{"data":"cccccccccc","next":20,"stream":"stderr"}`)
	g.take(t, `{"data":"dd","next":22,"stream":"stdout"}`)
	c.mu.Lock()
	c.phase, c.eofs = exited, 2
	c.check()
	c.mu.Unlock()
	g.take(t, `{"exitCode":0,"next":22}`)
}

func TestReadsDuringRotation(t *testing.T) {
	cmds := newTable()
	small(t, 50)
	c := fake(t, cmds, "ccccccccccc5")
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				r := httptest.NewRequest("GET", "/commands/"+c.id+"/output", nil)
				r.SetPathValue("id", c.id)
				w := httptest.NewRecorder()
				cmds.output(w, r)
				// Every answer joins up: skipped bytes, then data where byte p is '0' + p%10, then the closing next.
				pos := int64(0)
				for _, l := range strings.Split(strings.TrimSuffix(w.Body.String(), "\n"), "\n") {
					var m struct {
						Skipped *int64
						Data    *string
						Next    int64
					}
					json.Unmarshal([]byte(l), &m)
					switch {
					case m.Skipped != nil && pos+*m.Skipped != m.Next:
						t.Errorf("skipped line %s at %d", l, pos)
					case m.Data != nil && pos+int64(len(*m.Data)) != m.Next:
						t.Errorf("line %s at %d", l, pos)
					case m.Skipped == nil && m.Data == nil && m.Next != pos:
						t.Errorf("closing line %s at %d", l, pos)
					}
					if m.Data != nil {
						for i, b := range []byte(*m.Data) {
							if b != byte('0'+(pos+int64(i))%10) {
								t.Errorf("byte %d is %c", pos+int64(i), b)
								break
							}
						}
					}
					pos = m.Next
				}
			}
		}()
	}
	// Pieces of 7 bytes, on both streams in turn: many chunks and rotations while the readers read.
	total := 0
	for i := range 2000 {
		b := make([]byte, 7)
		for j := range b {
			b[j] = byte('0' + (total+j)%10)
		}
		c.write(stream(i%2), b)
		total += len(b)
	}
	close(stop)
	wg.Wait()
	if len(c.gens) != 2 || c.total != int64(total) {
		t.Fatalf("%d generations, total %d", len(c.gens), c.total)
	}
}

func TestEviction(t *testing.T) {
	old := keep
	keep = 2
	t.Cleanup(func() { keep = old })
	cmds := newTable()
	var started []*command
	for _, cmd := range [][]string{{"sh", "-c", "echo a; echo b >&2"}, {"true"}, {"true"}} {
		c, _, err := cmds.run(cmd)
		if err != nil {
			t.Fatal(err)
		}
		started = append(started, c)
	}
	// Nothing reaps in a test: collect until the three are finished.
	done := func(c *command) bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.phase >= finished
	}
	for _, c := range started {
		for deadline := time.Now().Add(10 * time.Second); !done(c); time.Sleep(10 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("%v never finished", c.cmd)
			}
			cmds.reap()
		}
	}
	// A reader of the oldest is between two lines when the next start evicts it: it ends with where it was.
	first := started[0]
	g := through(cmds, first, "")
	if got := <-g.lines; !strings.HasSuffix(got, `"next":2,"stream":"stdout"}`+"\n") && !strings.HasSuffix(got, `"next":2,"stream":"stderr"}`+"\n") {
		t.Fatalf("first line %q", got)
	}
	last, _, err := cmds.run([]string{"true"})
	if err != nil {
		t.Fatal(err)
	}
	g.open <- struct{}{}
	g.take(t, `{"next":2}`)

	if code, _ := get(t, cmds, first.id, ""); code != 404 {
		t.Errorf("evicted: %d", code)
	}
	if _, err := os.Stat(first.dir); !os.IsNotExist(err) {
		t.Errorf("folder still there: %v", err)
	}
	cmds.mu.Lock()
	ids := []string{}
	for _, c := range cmds.order {
		ids = append(ids, c.id)
	}
	cmds.mu.Unlock()
	if fmt.Sprint(ids) != fmt.Sprint([]string{started[1].id, started[2].id, last.id}) {
		t.Errorf("order %v", ids)
	}
}

func TestIdsCarryBoot(t *testing.T) {
	cmds := newTable()
	hex12 := regexp.MustCompile(`^[0-9a-f]{12}$`)
	if !regexp.MustCompile(`^[0-9a-f]{4}$`).MatchString(cmds.boot) {
		t.Fatalf("boot %q", cmds.boot)
	}
	c, _, err := cmds.run([]string{"true"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
			cmds.reap()
			c.mu.Lock()
			done := c.phase >= finished
			c.mu.Unlock()
			if done {
				return
			}
		}
	})
	if !hex12.MatchString(c.id) || !strings.HasPrefix(c.id, cmds.boot) {
		t.Fatalf("id %q, boot %q", c.id, cmds.boot)
	}
	// The 404 of an unknown id tells which run of the daemon answers.
	if code, out := get(t, cmds, "000000000000", ""); code != 404 || out[0]["error"] != "unknown command" || out[0]["boot"] != cmds.boot {
		t.Fatalf("unknown: %d %v", code, out)
	}
}

func TestStopAfterPidReuse(t *testing.T) {
	// Another group leader holds the pid of a command already collected.
	other := exec.Command("sleep", "30")
	other.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	ended := make(chan struct{})
	go func() { other.Wait(); close(ended) }()
	t.Cleanup(func() { other.Process.Kill(); <-ended })
	for _, p := range []phase{exited, finished} {
		c := &command{id: "ddddddddddd1", pid: other.Process.Pid, phase: p, changed: make(chan struct{})}
		c.signal(syscall.SIGKILL)
		// Waited for, not only Kill(pid, 0): a killed process stays a zombie until collected, and answers it too.
		select {
		case <-ended:
			t.Fatalf("phase %d: the other process was killed", p)
		case <-time.After(200 * time.Millisecond):
		}
		if err := syscall.Kill(other.Process.Pid, 0); err != nil {
			t.Fatalf("phase %d: %v", p, err)
		}
	}
}
