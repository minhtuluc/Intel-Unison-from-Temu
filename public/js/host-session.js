export function initializeHostSession() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get('host-token');
  if (token) {
    // Remove the capability from the address bar before navigation or rendering.
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#files`
    );
    sessionStorage.setItem('utrans_host_token', token);
  }
}

export function hostHeaders() {
  return { 'X-Host-Token': sessionStorage.getItem('utrans_host_token') || '' };
}
