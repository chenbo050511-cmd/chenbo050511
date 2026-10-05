/* WordMaster 移动端交互：更多菜单 + 底部导航 */
(function () {
  'use strict';

  const Mobile = {
    initialized: false,

    init() {
      if (this.initialized) return;
      this.initialized = true;

      const trigger = document.getElementById('mob-more-trigger');
      const mask = document.getElementById('mob-more-mask');
      const sheet = document.getElementById('mob-more-sheet');
      const closeBtn = document.getElementById('mob-more-close');

      if (!trigger || !mask || !sheet) return;

      // 打开菜单
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        this.open();
      });

      // 关闭菜单
      const close = () => this.close();
      mask.addEventListener('click', close);
      if (closeBtn) closeBtn.addEventListener('click', close);

      // 菜单内导航项点击
      sheet.querySelectorAll('.mob-more-item').forEach((item) => {
        item.addEventListener('click', () => {
          const view = item.dataset.view;
          if (view && window.App) {
            window.App.go('#/' + view);
            this.close();
          }
        });
      });

      // ESC 关闭
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sheet.classList.contains('show')) {
          this.close();
        }
      });
    },

    open() {
      const mask = document.getElementById('mob-more-mask');
      const sheet = document.getElementById('mob-more-sheet');
      if (!mask || !sheet) return;
      mask.classList.add('show');
      sheet.classList.add('show');
      document.body.style.overflow = 'hidden';
    },

    close() {
      const mask = document.getElementById('mob-more-mask');
      const sheet = document.getElementById('mob-more-sheet');
      if (!mask || !sheet) return;
      mask.classList.remove('show');
      sheet.classList.remove('show');
      document.body.style.overflow = '';
    },

    // 同步错题徽章到移动端菜单
    syncBadges() {
      const navBadge = document.getElementById('nav-badge-wrong');
      const mobBadge = document.getElementById('mob-badge-wrong');
      if (navBadge && mobBadge) {
        mobBadge.textContent = navBadge.textContent;
        mobBadge.classList.toggle('zero', navBadge.classList.contains('zero'));
      }
    }
  };

  window.Mobile = Mobile;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Mobile.init());
  } else {
    Mobile.init();
  }
})();
