// Change notes may carry a picture or a clip. The site and the release notes decide how to show it from the file name.
const videoPattern = /\.(?:mp4|webm)$/i;

export function isVideoUrl(url) {
  return videoPattern.test(url.split(/[?#]/)[0]);
}

// Only https URLs and site-relative paths ("/media/x.png") are allowed, so a note cannot pull in a script or a tracker over http.
export function isAllowedMediaUrl(url) {
  return /^https:\/\/\S+$/.test(url) || /^\/(?!\/)\S*$/.test(url);
}
