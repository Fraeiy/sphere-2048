export function isInIframe(): boolean {
  try {
    return window.parent !== window && window.self !== window.top;
  } catch {
    return true;
  }
}

export function hasExtension(): boolean {
  try {
    const sphere = (window as Window & { sphere?: { isInstalled?: () => boolean } }).sphere;
    return typeof sphere?.isInstalled === 'function' && sphere.isInstalled() === true;
  } catch {
    return false;
  }
}