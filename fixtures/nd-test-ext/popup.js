document.getElementById("out").textContent = `popup ${chrome.runtime.id}`;
// The drive's proof that a popup page closing itself reaches the app: a real
// extension popup does this whenever its own UI is done.
document.getElementById("close").addEventListener("click", () => window.close());
