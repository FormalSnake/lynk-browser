// A message wakes the worker whenever it is asleep, which a drive talking to
// the worker over CDP could not count on.
chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  chrome.tabs.create({ url: message.url }).then(() => reply("ok"), (e) => reply(String(e)));
  return true;
});
