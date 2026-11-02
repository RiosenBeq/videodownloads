// 5. A video injected after load (MutationObserver path).
setTimeout(() => {
  const v = document.createElement('video');
  v.src = '/sample.webm?injected=1';
  v.title = 'Injected later';
  v.muted = true;
  document.getElementById('late').appendChild(v);
}, 1200);

// 6. A Media Source Extensions player: the element only exposes a blob: URL.
if (window.MediaSource) {
  const ms = new MediaSource();
  document.getElementById('mse').src = URL.createObjectURL(ms);
}

// 7. Streaming players fetch manifests with XHR/fetch; the extension sees them on the network.
for (const url of ['/hls-ts/master.m3u8', '/dash/manifest.mpd', '/hls-enc/index.m3u8']) {
  fetch(url).then((r) => r.text()).catch(() => {});
}
