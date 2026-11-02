import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously,
  GoogleAuthProvider, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig, OWNER_NAME } from "./config.js";

const COL = "drawings";
const MAX_CHARS = 850_000;   // stored image (data URL) must stay under Firestore's 1 MB doc limit
const MAX_SIDE = 1600;       // px, longest side of the stored preview

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
let me = null, ownerMode = false, items = [], loaded = false, subscribed = false;
let pending = null; // prepared data URL of the chosen file

let nick = "";
try { nick = localStorage.getItem("rosa-nick") || ""; } catch {}
$("name").value = nick;
$("name").addEventListener("input", (e) => { try { localStorage.setItem("rosa-nick", e.target.value); } catch {} });

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c);
  return n;
}
const say = (t) => { $("msg").textContent = t || ""; };
function showErr(e) {
  console.error(e);
  say(e?.code === "permission-denied" ? "Not allowed, sorry ✿" : (e?.message || String(e)));
}

// ---------- auth ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) { try { await signInAnonymously(auth); } catch (e) { showErr(e); } return; }
  me = user;
  ownerMode = !user.isAnonymous;
  renderWho();
  if (!subscribed) {
    subscribed = true;
    onSnapshot(query(collection(db, COL), orderBy("createdAt", "desc")),
      (s) => { items = s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })); loaded = true; render(); },
      showErr);
  }
  render();
});
window.addEventListener("hashchange", () => renderWho());

function renderWho() {
  const who = $("who");
  who.replaceChildren();
  if (ownerMode) {
    who.append(el("span", { class: "badge" }, `${OWNER_NAME} (owner)`),
      el("button", { class: "link", onclick: () => signOut(auth) }, "sign out"));
    $("name").hidden = true;
  } else {
    $("name").hidden = false;
    if (location.hash === "#admin") {
      who.append(el("button", { onclick: () => signInWithPopup(auth, new GoogleAuthProvider()).catch(showErr) }, "Owner sign-in"));
    }
  }
}

// ---------- file → compressed JPEG data URL ----------
async function fileToCanvas(file) {
  if (file.type === "application/pdf") {
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error("PDF reader didn't load, try reloading the page.");
    pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = MAX_SIDE / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  }
  if (!file.type.startsWith("image/")) throw new Error("Only PDF, JPG or PNG please ✿");
  const img = await createImageBitmap(file);
  const s = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
function compress(canvas) {
  let c = canvas;
  for (let i = 0; i < 8; i++) {
    for (const q of [0.82, 0.7, 0.58]) {
      const url = c.toDataURL("image/jpeg", q);
      if (url.length < MAX_CHARS) return url;
    }
    const n = document.createElement("canvas");     // shrink and retry
    n.width = Math.round(c.width * 0.8); n.height = Math.round(c.height * 0.8);
    n.getContext("2d").drawImage(c, 0, 0, n.width, n.height);
    c = n;
  }
  throw new Error("That file is too big even after shrinking.");
}

async function choose(file) {
  pending = null; $("prev").hidden = true; say("");
  if (!file) return;
  $("dropText").innerHTML = "<b>Preparing…</b>";
  try {
    pending = compress(await fileToCanvas(file));
    $("prev").src = pending; $("prev").hidden = false;
    $("dropText").replaceChildren(el("b", {}, file.name), el("br"), "tap to change");
  } catch (e) {
    $("dropText").innerHTML = "<b>Choose a drawing</b><br>PDF, JPG or PNG";
    showErr(e);
  }
}
$("file").addEventListener("change", (e) => choose(e.target.files[0]));
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); choose(e.dataTransfer.files[0]); });

$("upForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!me) { say("Still connecting, try again in a second."); return; }
  if (!pending) { say("Choose a drawing first ✿"); return; }
  const btn = $("goBtn"); btn.disabled = true; say("Uploading…");
  try {
    await addDoc(collection(db, COL), {
      uid: me.uid,
      byOwner: ownerMode,
      name: ownerMode ? OWNER_NAME : ($("name").value.trim().slice(0, 30) || "Anonymous"),
      title: $("title").value.trim().slice(0, 80),
      image: pending,
      createdAt: serverTimestamp(),
    });
    pending = null; $("file").value = ""; $("title").value = ""; $("prev").hidden = true;
    $("dropText").innerHTML = "<b>Choose a drawing</b><br>PDF, JPG or PNG";
    say("Uploaded ✿ thank you!");
    setTimeout(() => say(""), 3000);
  } catch (err) { showErr(err); }
  finally { btn.disabled = false; }
});

// ---------- gallery ----------
const canDelete = (x) => ownerMode || (x.uid === me?.uid && !x.byOwner);

function render() {
  const grid = $("grid");
  grid.replaceChildren();
  $("empty").textContent = !loaded ? "Loading…" : items.length ? "" : "No drawings yet. Be the first ✿";
  for (const x of items) {
    const card = el("div", { class: "pic" + (x.byOwner ? " owner" : "") },
      el("img", { src: x.image, alt: x.title || "drawing", loading: "lazy", onclick: () => zoom(x.image) }),
      x.title ? el("div", { class: "t" }, x.title) : null,
      el("div", { class: "by" }, `by ${x.byOwner ? OWNER_NAME : (x.name || "Anonymous")}`),
      canDelete(x) ? el("button", {
        class: "x", title: "Delete",
        onclick: () => { if (confirm("Delete this drawing?")) deleteDoc(doc(db, COL, x.id)).catch(showErr); },
      }, "×") : null,
    );
    grid.append(card);
  }
  $("foot").textContent = ownerMode
    ? "Owner mode: you can delete anything."
    : "Anyone can add drawings. You can delete only your own.";
}

function zoom(src) { $("zoomImg").src = src; $("zoom").classList.add("on"); }
$("zoom").addEventListener("click", () => $("zoom").classList.remove("on"));
