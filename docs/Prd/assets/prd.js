// Highlights the current section in the contents rail.
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      links.forEach(function (l) { l.classList.toggle('on', l.getAttribute('href') === '#' + en.target.id); });
    });
  }, { rootMargin: '-15% 0px -75% 0px' });
  document.querySelectorAll('main section[id]').forEach(function (s) { io.observe(s); });
})();
