// parpaing web page: the script of index.html, a separate file so the CSP can forbid inline scripts.
const $ = (id) => document.getElementById(id);
const BASE = location.origin;
$("status-api").textContent = BASE;

// The API key, only when this parpaing asks for one (PARPAING_API_KEY): the field shows up on the first 401,
// the key stays in this browser and goes with every call.
const keyField = $("api-key");
try { keyField.value = localStorage.getItem("parpaing-api-key") ?? ""; } catch {}
keyField.hidden = !keyField.value;
keyField.onchange = () => {
  try { localStorage.setItem("parpaing-api-key", keyField.value.trim()); } catch {}
  refresh();
};
const authorize = (headers) => (keyField.value.trim() ? { ...headers, authorization: `Bearer ${keyField.value.trim()}` } : headers);
function askKey(status) {
  if (status !== 401) return;
  keyField.hidden = false;
  keyField.focus();
}

// Aglo, the mascot: shows a drawing of the brand kit (docs/brand/aglo), served by nginx at /brand.
// A new URL for the error reloads the file, so its fall plays again.
function aglo(slot, pose) {
  slot.dataset.pose = pose ?? "";
  if (!pose) return slot.replaceChildren();
  const img = new Image();
  img.alt = "";
  img.src = `/brand/aglo/aglo-${pose}.svg` + (pose === "error" ? `?t=${Date.now()}` : "");
  slot.replaceChildren(img);
}

// The message of a step: what is running ("working"), what failed ("error"), or what just worked.
function note(id, text, pose) {
  const box = $(id);
  box.hidden = !text;
  box.className = `note ${pose ?? ""}`;
  aglo(box.querySelector(".aglo"), pose);
  box.querySelector(".text").textContent = text ?? "";
}

// Why a call failed: the API answers { error }, a server that is down leaves the text written in call().
const why = (data) => data?.error ?? data;

// One call on one line: method and path, status ("running" while it runs), duration.
function summary(method, path, status, ms) {
  const what = document.createElement("code");
  what.textContent = `${method} ${path}`;
  const badge = document.createElement("span");
  badge.className = `status${status === undefined ? " run" : status >= 200 && status < 300 ? "" : " bad"}`;
  badge.textContent = status === undefined ? "running" : status || "not responding";
  const time = document.createElement("span");
  time.className = "ms";
  time.textContent = ms === undefined ? "" : `${ms} ms`;
  return [what, badge, time];
}

// Sends the request, then adds it to the top of the drawer with its curl equivalent and its response.
async function call(method, path, body) {
  const options = { method, headers: authorize(body ? { "content-type": "application/json" } : {}) };
  if (body) options.body = JSON.stringify(body);
  $("status-last").replaceChildren(...summary(method, path));
  const started = performance.now();
  let status = 0, text = "";
  try {
    const res = await fetch(path, options);
    status = res.status;
    askKey(status);
    text = await res.text();
  } catch (error) {
    text = `parpaing is not responding (${error.message}). Is it running with docker compose up -d?`;
  }
  const ms = Math.round(performance.now() - started);
  let data;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  log(method, path, body, status, data, ms);
  return { status, data };
}

let calls = 0;
function log(method, path, body, status, data, ms) {
  // -N: curl prints each line as soon as it arrives, without waiting for the end.
  const curl = `curl ${path.endsWith("/exec") ? "-N " : ""}-X ${method} ${BASE}${path}` + (keyField.value.trim() ? ' -H "authorization: Bearer $PARPAING_API_KEY"' : "") + (body ? ` -H 'content-type: application/json' -d '${JSON.stringify(body).replaceAll("'", "'\\''")}'` : "");
  const shown = data === undefined ? "(no body)" : typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const entry = document.createElement("li");
  entry.className = "call";
  entry.innerHTML = `<div class="line"></div>
    <div class="curl-row"><pre class="curl"></pre><button type="button">Copy</button></div>
    <pre class="sent"></pre>
    <details><summary>Response</summary><pre class="got"></pre></details>`;
  entry.querySelector(".line").append(...summary(method, path, status, ms));
  entry.querySelector(".curl").textContent = curl;
  entry.querySelector(".sent").textContent = body ? JSON.stringify(body) : "";
  entry.querySelector(".sent").hidden = !body;
  entry.querySelector(".got").textContent = shown;
  const copy = entry.querySelector("button");
  copy.onclick = () => navigator.clipboard.writeText(curl).then(() => "Copied", () => "Copy failed").then((label) => {
    copy.textContent = label;
    setTimeout(() => { copy.textContent = "Copy"; }, 1500);
  });
  $("status-last").replaceChildren(...summary(method, path, status, ms));
  $("log-count").textContent = ++calls;
  const box = $("log");
  box.querySelector(".quiet")?.remove();
  box.prepend(entry);
  box.scrollTop = 0;
}

// The two blocks of the logo: the blue one with round eyes is a running sandbox, the steel one a stopped sandbox.
const BLOCK = {
  running: `<rect width="40" height="24" rx="2" fill="#5cc2ff"/><circle cx="12" cy="12" r="4.3" fill="#121419"/><circle cx="28" cy="12" r="4.3" fill="#121419"/>`,
  stopped: `<rect width="40" height="24" rx="2" fill="#6e7891"/><rect x="8" y="8" width="8" height="8" fill="#121419"/><rect x="24" y="8" width="8" height="8" fill="#121419"/>`,
};

// chosen: the sandbox commands go to. total: how many sandboxes the list shows.
let chosen, running = false, creating = false, total = 0;

// The step to do now: 1 with no sandbox, 2 with sandboxes but none picked, 3 once one is picked.
function guide() { document.body.dataset.step = chosen ? 3 : total ? 2 : 1; }

function ready() {
  $("cmd").disabled = !chosen;
  $("exec-btn").disabled = !chosen || running;
  $("cmd").placeholder = chosen ? "ls -la /" : "Create or pick a sandbox first.";
  $("term").dataset.hint = chosen ? "Type a command below and press Enter. It runs with sh -c." : "Create or pick a sandbox first.";
}

// Radio keyboard pattern: only the picked row (or the first one) is in the tab order.
function roving() {
  const picks = [...$("list").querySelectorAll(".pick")];
  picks.forEach((pick, i) => { pick.tabIndex = (chosen ? pick.parentElement.dataset.id === chosen : i === 0) ? 0 : -1; });
}

async function refresh() {
  const { status, data } = await call("GET", "/sandboxes");
  const list = $("list");
  list.replaceChildren();
  if (status !== 200) return note("list-note", why(data), "error");
  note("list-note");
  total = data.length;
  if (chosen && !data.some((sandbox) => sandbox.id === chosen)) choose();
  for (const sandbox of data) {
    const row = document.createElement("li");
    row.className = "row";
    row.setAttribute("role", "none");
    row.dataset.id = sandbox.id;
    row.innerHTML = `<button type="button" class="pick" role="radio" aria-checked="false"><svg class="block" viewBox="0 0 40 24" aria-hidden="true">${BLOCK[sandbox.state] ?? BLOCK.stopped}</svg><code></code><span class="state"></span></button><button type="button" class="danger">Delete</button>`;
    row.querySelector("code").textContent = sandbox.id;
    row.querySelector(".state").textContent = sandbox.state;
    row.classList.toggle("chosen", sandbox.id === chosen);
    row.querySelector(".pick").setAttribute("aria-checked", sandbox.id === chosen);
    const del = row.querySelector(".danger");
    row.onclick = (event) => { if (!del.contains(event.target)) choose(sandbox.id, true); };
    // First click: the button asks for confirmation; second click: the sandbox is deleted.
    del.onclick = async () => {
      if (!del.classList.contains("armed")) {
        del.classList.add("armed");
        del.textContent = "Confirm delete";
        setTimeout(() => { del.classList.remove("armed"); del.textContent = "Delete"; }, 3000);
        return;
      }
      del.disabled = true;
      const gone = await call("DELETE", `/sandboxes/${sandbox.id}`);
      await refresh();
      if (gone.status === 204) note("list-note", `Sandbox ${sandbox.id} deleted.`);
      else note("list-note", `Could not delete sandbox ${sandbox.id}: ${why(gone.data)}`, "error");
    };
    list.append(row);
  }
  if (!data.length) {
    list.innerHTML = `<li class="empty"><span class="aglo"></span><b>No sandboxes yet.</b>Create one in step 1: without an image, it starts from debian:trixie-slim.</li>`;
    aglo(list.querySelector(".aglo"), "empty");
  }
  roving();
  guide();
  if (!chosen && !creating && data.length === 1) choose(data[0].id);
}

// Picks the sandbox for step 3 and reads it (GET /sandboxes/:id) to say its state in the terminal.
async function choose(id, focus) {
  if (id && id === chosen) return focus && $("cmd").focus();
  chosen = id;
  ready();
  $("exec-target").textContent = id ?? "";
  $("exec-in").hidden = !id;
  $("term").replaceChildren();
  aglo($("term-aglo"), "idle");
  for (const row of $("list").children) {
    row.classList.toggle("chosen", row.dataset.id === id);
    row.querySelector(".pick")?.setAttribute("aria-checked", row.dataset.id === id);
  }
  roving();
  guide();
  if (!id) return;
  if (focus) $("cmd").focus();
  const one = await call("GET", `/sandboxes/${id}`);
  // A command typed in the meantime owns the terminal.
  if (chosen !== id || $("term").childElementCount) return;
  if (one.status === 200) print(`Sandbox ${one.data.id} is ${one.data.state}. Type a command below and press Enter (it runs with sh -c).\n`, "info");
  else {
    print(`Could not read sandbox ${id}: ${why(one.data)}\n`, "stderr");
    aglo($("term-aglo"), "error");
  }
}

$("list").onkeydown = (event) => {
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
  const picks = [...$("list").querySelectorAll(".pick")];
  const at = picks.indexOf(document.activeElement);
  if (!step || at < 0) return;
  event.preventDefault();
  const to = picks[(at + step + picks.length) % picks.length];
  choose(to.parentElement.dataset.id);
  to.focus();
};

function print(text, className) {
  const span = document.createElement("span");
  span.textContent = text;
  if (className) span.className = className;
  $("term").append(span);
  $("term").scrollTop = $("term").scrollHeight;
}

// The typed line goes to sh -c as is. The output shows up as the JSON lines arrive;
// the drawer keeps those raw lines.
$("exec").onsubmit = async (event) => {
  event.preventDefault();
  const typed = $("cmd").value.trim();
  if (!typed || !chosen) return;
  const path = `/sandboxes/${chosen}/exec`;
  const body = { cmd: ["sh", "-c", typed] };
  const btn = $("exec-btn");
  running = true;
  ready();
  btn.textContent = "Running…";
  aglo($("term-aglo"), "working");
  $("status-last").replaceChildren(...summary("POST", path));
  $("term").replaceChildren();
  print("$ ", "dollar");
  print(`${typed}\n`);
  const started = performance.now();
  let status = 0, raw = "", failed = false;
  try {
    const res = await fetch(path, { method: "POST", headers: authorize({ "content-type": "application/json" }), body: JSON.stringify(body) });
    status = res.status;
    askKey(status);
    if (!res.ok) {
      raw = await res.text();
      print(raw, "stderr");
      failed = true;
    } else {
      let rest = "";
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        raw += chunk;
        const lines = (rest + chunk).split("\n");
        rest = lines.pop();
        for (const text of lines.filter(Boolean)) {
          const msg = JSON.parse(text);
          if (msg.stream) print(msg.data, msg.stream === "stderr" ? "stderr" : "");
          else if ("exitCode" in msg) print(`\n[exit code ${msg.exitCode}]`, msg.exitCode === 0 ? "end" : "bad");
          else if (msg.error) { print(`\n[error: ${msg.error}]`, "stderr"); failed = true; }
        }
      }
    }
  } catch (error) {
    raw = `parpaing is not responding (${error.message})`;
    print(raw, "stderr");
    failed = true;
  }
  log("POST", path, body, status, raw.trimEnd(), Math.round(performance.now() - started));
  running = false;
  ready();
  btn.textContent = "Run command";
  // Aglo falls only when the request itself failed, not when the command ends with a non-zero code.
  aglo($("term-aglo"), failed ? "error" : "idle");
  $("cmd").select();
};

$("create").onsubmit = async (event) => {
  event.preventDefault();
  const image = $("image").value.trim();
  const btn = $("create-btn");
  btn.disabled = creating = true;
  btn.textContent = "Creating…";
  note("create-note", `Creating a sandbox from ${image || "debian:trixie-slim"}. The first use of an image downloads it, which can take a while.`, "working");
  const { status, data } = await call("POST", "/sandboxes", image ? { image } : {});
  await refresh();
  btn.disabled = creating = false;
  btn.textContent = "Create sandbox";
  if (status !== 201) return note("create-note", `Could not create the sandbox: ${why(data)}`, "error");
  note("create-note", `Sandbox ${data.id} created and picked for step 3.`);
  choose(data.id, true);
};

// The drawer: open by default on wide screens, then as the user last left it (when the browser lets us remember).
const WIDE = matchMedia("(min-width: 1400px)");
function drawer(open, save) {
  $("log-drawer").hidden = !open;
  $("log-toggle").setAttribute("aria-expanded", open);
  if (save) try { localStorage.setItem("parpaing-api-calls", open ? "open" : "closed"); } catch {}
}
let saved;
try { saved = localStorage.getItem("parpaing-api-calls"); } catch {}
// Closed by default; opening it is remembered.
drawer(saved === "open");
$("log-toggle").onclick = () => drawer($("log-drawer").hidden, true);
$("status-last").onclick = () => drawer(true, true);
$("log-close").onclick = () => drawer(false, true);
addEventListener("keydown", (event) => { if (event.key === "Escape" && !WIDE.matches && !$("log-drawer").hidden) drawer(false, true); });

$("refresh").onclick = refresh;
$("clear").onclick = () => {
  $("log").innerHTML = `<li class="quiet">No calls yet.</li>`;
  $("log-count").textContent = calls = 0;
};
choose();
refresh();
