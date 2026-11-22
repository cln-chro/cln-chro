/* Service worker for Reel Vault.
 *
 * A <video> tag can't send an Authorization header, which is why the app has
 * been downloading whole files into memory before playing them. This sits in
 * between: the page points the video at a path on its own origin, this worker
 * intercepts that request, attaches the token, and forwards it to Drive —
 * passing Range headers through untouched.
 *
 * That hands playback back to the browser, which fetches only the parts it
 * needs. Large files stop mattering, and a clip watched for five seconds
 * costs roughly five seconds of data.
 */

/* The browser shuts a worker down when it goes idle, which loses anything
   held in a variable. The page therefore puts the token on the request it
   makes to us. That URL is same-origin and intercepted here before any
   network call, so the token never leaves the device; it reaches Drive as
   a normal Authorization header. */
let token = null;

self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("message", e => {
  if (e.data && e.data.type === "token"){
    token = e.data.token;
    if (e.source) e.source.postMessage({ type: "token-ok" });
  }
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  const m = url.pathname.match(/\/drive-stream\/([A-Za-z0-9_-]+)$/);
  if (!m) return;                                   // not ours; leave it alone

  const id = m[1];
  const fromUrl = url.searchParams.get("t");
  const total = parseInt(url.searchParams.get("s") || "0", 10);
  if (fromUrl) token = fromUrl;

  event.respondWith((async () => {
    const auth = fromUrl || token;
    if (!auth) return new Response("no token yet", { status: 503 });

    const headers = { Authorization: "Bearer " + auth };
    const range = event.request.headers.get("range");
    if (range) headers.Range = range;               // let the browser seek

    const upstream = await fetch(
      `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
      { headers });

    if (!upstream.ok && upstream.status !== 206){
      return new Response("upstream " + upstream.status, { status: upstream.status });
    }

    /* Cross-origin responses only expose a handful of headers, and
       Content-Range is not among them — so a 206 copied verbatim arrives
       without it and the browser rejects the response. Content-Length is
       readable, and the page tells us the file's total size, which is
       enough to write the header ourselves. */
    const out = new Headers();
    out.set("content-type", upstream.headers.get("content-type") || "video/mp4");
    out.set("accept-ranges", "bytes");

    const lenHdr = upstream.headers.get("content-length");
    const len = lenHdr ? parseInt(lenHdr, 10) : 0;
    if (len) out.set("content-length", String(len));

    let status = 200;
    if (upstream.status === 206){
      const q = /bytes=(\d*)-(\d*)/.exec(range || "");
      const start = q && q[1] ? parseInt(q[1], 10) : 0;
      if (total && len){
        out.set("content-range", `bytes ${start}-${start + len - 1}/${total}`);
        status = 206;
      } else if (start > 0){
        /* A partial reply we cannot describe is worse than none: say so
           and let the page fall back to downloading the file. */
        return new Response("cannot describe range", { status: 500 });
      }
    }

    return new Response(upstream.body, { status, headers: out });
  })());
});
