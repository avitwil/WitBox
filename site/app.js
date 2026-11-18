// WitBox website — language switch, 3D logo tilt, reveal on scroll, copy buttons.
(function () {
  var root = document.documentElement;
  function setLang(l, save) {
    root.dataset.lang = l; root.lang = l; root.dir = l === 'he' ? 'rtl' : 'ltr';
    document.querySelectorAll('img[data-shot]').forEach(function (i) { i.src = 'img/' + l + '/' + i.dataset.shot + '.webp'; });
    document.querySelectorAll('[data-title-' + l + ']').forEach(function (e) { document.title = e.getAttribute('data-title-' + l); });
    if (save) { try { localStorage.witboxLang = l; } catch (e) {} }
  }
  var q = /[?&]lang=(he|en)/.exec(location.search), saved = null;
  try { saved = localStorage.witboxLang; } catch (e) {}
  setLang(q ? q[1] : saved || (/^he|^iw/i.test(navigator.language || '') ? 'he' : 'en'), !!q);
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.langbtn'); if (b) setLang(root.dataset.lang === 'he' ? 'en' : 'he', true);
    var c = e.target.closest('.copy');
    if (c) { navigator.clipboard.writeText(c.parentNode.querySelector('code').innerText.trim()).then(function () { var t = c.textContent; c.textContent = '✓'; setTimeout(function () { c.textContent = t; }, 1300); }); }
  });
  var nav = document.querySelector('.nav');
  addEventListener('scroll', function () { nav && nav.classList.toggle('scrolled', scrollY > 8); }, { passive: true });

  // 3D logo: sways on its own, follows the pointer while it is over the hero
  var stage = document.querySelector('.stage'), logo = document.querySelector('.logo3d'), hero = document.querySelector('.hero');
  if (stage && logo && hero && matchMedia('(hover:hover)').matches && !matchMedia('(prefers-reduced-motion:reduce)').matches) {
    var idle;
    hero.addEventListener('pointermove', function (e) {
      var r = stage.getBoundingClientRect(), x = (e.clientX - (r.left + r.width / 2)) / r.width, y = (e.clientY - (r.top + r.height / 2)) / r.height;
      x = Math.max(-1.4, Math.min(1.4, x)); y = Math.max(-1.4, Math.min(1.4, y));
      logo.classList.add('tilt'); logo.style.transform = 'rotateY(' + (x * 24) + 'deg) rotateX(' + (-y * 18) + 'deg) translateZ(10px)';
      clearTimeout(idle); idle = setTimeout(release, 2200);
    });
    hero.addEventListener('pointerleave', release);
    function release() { logo.style.transform = ''; logo.classList.remove('tilt'); logo.style.animation = 'sway 9s ease-in-out infinite'; }
  }
  var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { threshold: 0.14 });
  document.querySelectorAll('.reveal,.heroshot').forEach(function (el) { io.observe(el); });
})();
