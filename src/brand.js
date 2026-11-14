import './site-tokens.css';
import './brand.css';
import { addColorToggle } from './site-color.js';

for (const brand of document.querySelectorAll('a.brand')) {
  const mark = document.createElement('img');
  mark.src = '/brand/crucible-mark.svg';
  mark.alt = '';
  mark.width = mark.height = 34;
  mark.className = 'brand-mark';
  brand.prepend(mark);
}

const siteNavigation = document.querySelector('body.site .navigation');
if (siteNavigation) addColorToggle(siteNavigation);

// Local SVGs share one stroke style and never depend on a third-party icon CDN.
const paths = {
  cube:'M12 3 3 8v9l9 5 9-5V8l-9-5ZM3 8l9 5 9-5M12 13v9M7.5 5.5l9 5',
  book:'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4V4Zm9 3a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2',
  download:'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  code:'m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  film:'M3 4h18v16H3V4Zm4 0v16M17 4v16M3 9h4m-4 6h4m10-6h4m-4 6h4',
  leaf:'M20 3C8 2 2 8 5 15s15 6 15-12ZM4 21 15 10',
  image:'M3 3h18v18H3V3Zm0 14 6-6 5 5 3-3 4 4M16 8h.01',
  package:'M3 7 12 2l9 5v10l-9 5-9-5V7Zm0 0 9 5 9-5M12 12v10M7.5 4.5l9 5v4',
  history:'M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5M12 7v5l3.5 2',
  motion:'M4 12c3-8 5 8 8 0s5 8 8 0',
  heart:'M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9Z',
  github:'M9 19c-4 1-4-2-6-2m12 5v-4a3.5 3.5 0 0 0-1-2.7c3.3-.4 6.7-1.6 6.7-7.3a5.7 5.7 0 0 0-1.5-4 5.3 5.3 0 0 0-.1-4S18 0 15 2a14 14 0 0 0-7 0C5 0 3.9 0 3.9 0a5.3 5.3 0 0 0-.1 4 5.7 5.7 0 0 0-1.5 4c0 5.7 3.4 6.9 6.7 7.3A3.5 3.5 0 0 0 8 18v4',
};
const labels = { Examples:'cube', Showcase:'cube', Docs: 'book', Changelog:'history', Documentation:'book', 'Getting started':'book', Downloads:'download', 'Package source':'code', Object:'cube', Nature:'leaf', Film:'film', Motion:'motion', Animation:'film', 'Save PNG':'image', 'Export GLB':'download' };
for (const element of document.querySelectorAll('nav a, [data-icon], #save-image, #export')) {
  // Footer links stay plain text; only header and page navigation get an icon by label.
  const labelIcon = element.closest('.footer-links') ? undefined : labels[element.textContent.trim().replace(/[↓↗]/g, '').trim()];
  const name = element.dataset.icon ?? labelIcon;
  if (!paths[name]) continue;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox','0 0 24 24');
  svg.setAttribute('aria-hidden','true');
  svg.setAttribute('class','icon');
  svg.setAttribute('fill','none');
  svg.setAttribute('stroke','currentColor');
  svg.setAttribute('stroke-width','1.6');
  svg.setAttribute('stroke-linecap','round');
  svg.setAttribute('stroke-linejoin','round');
  const path = document.createElementNS(svg.namespaceURI,'path');
  path.setAttribute('d',paths[name]);
  svg.append(path);
  if (element.matches('nav a')) {
    const label = document.createElement('span');
    label.className = 'nav-label';
    label.append(...element.childNodes);
    element.append(svg, label);
  } else {
    element.prepend(svg);
  }
}
