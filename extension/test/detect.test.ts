import { beforeEach, describe, expect, it } from 'vitest';
import { collectVideos, describeVideoElement, elementTitle, parseHeightHint } from '../src/content/detect';

function setBody(html: string, head = '') {
  document.head.innerHTML = head;
  document.body.innerHTML = html;
}

describe('collectVideos', () => {
  beforeEach(() => {
    document.title = 'Holiday clips';
  });

  it('finds <video src> with title and poster', () => {
    setBody('<video src="/media/beach.mp4" poster="/img/beach.jpg" title="Beach day"></video>');
    const [video] = collectVideos(document);
    expect(video).toMatchObject({
      url: 'http://localhost:3000/media/beach.mp4',
      origin: 'dom',
      title: 'Beach day',
      posterUrl: 'http://localhost:3000/img/beach.jpg',
    });
  });

  it('collects <source> alternatives with resolution hints', () => {
    setBody(`<figure>
      <video>
        <source src="/v/clip-1080.mp4" type="video/mp4" size="1080">
        <source src="/v/clip-720.mp4" type="video/mp4" label="720p">
        <source src="/v/clip.webm" type="video/webm">
      </video>
      <figcaption>Mountain timelapse</figcaption>
    </figure>`);
    const [video] = collectVideos(document);
    expect(video.url).toBe('http://localhost:3000/v/clip-1080.mp4');
    expect(video.title).toBe('Mountain timelapse');
    expect(video.sources?.map((s) => s.height)).toEqual([1080, 720, undefined]);
    expect(video.sources?.[2].type).toBe('video/webm');
  });

  it('detects blob/MSE players and DRM usage', () => {
    setBody('<video id="mse"></video>');
    const el = document.getElementById('mse') as HTMLVideoElement;
    Object.defineProperty(el, 'currentSrc', { value: 'blob:http://localhost:3000/1234' });
    const drm = new WeakSet<Element>([el]);
    const [video] = collectVideos(document, { drmElements: drm });
    expect(video.url).toBe('blob:http://localhost:3000/1234');
    expect(video.drm).toBe(true);
  });

  it('treats mediaKeys as DRM', () => {
    setBody('<video src="/a.mp4"></video>');
    const el = document.querySelector('video')!;
    Object.defineProperty(el, 'mediaKeys', { value: {} });
    expect(describeVideoElement(el, document)?.drm).toBe(true);
  });

  it('finds videos inside open shadow roots', () => {
    setBody('<div id="host"></div>');
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<video src="/shadow.webm"></video>';
    expect(collectVideos(document).map((v) => v.url)).toContain('http://localhost:3000/shadow.webm');
  });

  it('finds links to video files and manifests, ignoring other links', () => {
    setBody(`
      <a href="/files/talk.mp4" download="Conference talk.mp4">Download talk</a>
      <a href="/live/stream.m3u8">Stream</a>
      <a href="/doc.pdf">PDF</a>
      <a href="javascript:void(0)">x</a>`);
    const videos = collectVideos(document);
    expect(videos.map((v) => [v.url, v.origin, v.title])).toEqual([
      ['http://localhost:3000/files/talk.mp4', 'link', 'Conference talk.mp4'],
      ['http://localhost:3000/live/stream.m3u8', 'link', 'Stream'],
    ]);
  });

  it('reads og:video metadata', () => {
    setBody(
      '',
      `<meta property="og:title" content="Product launch">
       <meta property="og:video" content="https://cdn.example.com/launch.mp4">
       <meta property="og:video:type" content="video/mp4">
       <meta property="og:video:width" content="1920"><meta property="og:video:height" content="1080">
       <meta property="og:image" content="https://cdn.example.com/launch.jpg">`,
    );
    const [video] = collectVideos(document);
    expect(video).toMatchObject({ url: 'https://cdn.example.com/launch.mp4', origin: 'meta', title: 'Product launch', width: 1920, height: 1080 });
  });

  it('deduplicates by URL, preferring DOM elements', () => {
    setBody('<a href="/same.mp4">link</a><video src="/same.mp4" aria-label="Player"></video>');
    const videos = collectVideos(document);
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({ origin: 'dom', title: 'Player' });
  });

  it('ignores empty players and data: URLs', () => {
    setBody('<video></video><video src="data:video/mp4;base64,AAAA"></video>');
    expect(collectVideos(document)).toEqual([]);
  });
});

describe('helpers', () => {
  it('parses height hints', () => {
    expect(parseHeightHint('1080p')).toBe(1080);
    expect(parseHeightHint('HD 720')).toBe(720);
    expect(parseHeightHint('4K')).toBe(2160);
    expect(parseHeightHint('clip-480.mp4')).toBe(480);
    expect(parseHeightHint('high')).toBeUndefined();
  });

  it('falls back to the document title', () => {
    setBody('<video src="/x.mp4"></video>');
    document.title = 'Fallback title';
    expect(elementTitle(document.querySelector('video')!, document)).toBe('Fallback title');
  });
});
