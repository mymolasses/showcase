/* SPDX-License-Identifier: GPL-3.0-or-later */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  $('player').href = location.origin + '/';
  let count = 0, busy = false;
  async function check() {
    if (busy || document.hidden) return;
    busy = true;
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 4000);
    try {
      const response = await fetch('/probe.json', {cache: 'no-store', signal: abort.signal});
      if (!response.ok) throw Error('HTTP ' + response.status);
      const s = await response.json();
      $('status').textContent = `双向 HTTP 响应正常 · ${++count} 次`;
      $('status').className = 'ok';
      $('network').textContent = s.localReady ? '本机兼容地址及本地路由已验证。当前浏览器请求已到达接收 iPhone。' : '普通入口已连通；兼容地址状态：' + s.phase;
      $('details').textContent = [
        '版本：' + s.version,
        '构建：' + (s.build || '未知'),
        '域名：' + s.domain,
        'HTTPS：' + s.httpsStatus,
        '当前入口：' + location.origin,
        '接收机热点：' + (s.hotspotAddress || '未检测到'),
        '兼容地址：' + s.compatibilityAddress,
        '连接返回接口：' + (s.returnInterface || '未确认'),
        '热点回程检查：' + (s.returnRoutePending ? '后台检查中' : s.returnViaHotspot ? '通过' : '未通过或当前为本机测试'),
        '连续失败：' + (s.consecutiveFailures || 0) + '；自动重试等待：' + Math.ceil((s.retryInMs || 0) / 1000) + ' 秒',
        '后台检查耗时：' + Math.round(s.routeCheckDurationMs || 0) + ' ms；结果年龄：' + Math.round(s.routeCheckAgeMs ?? -1) + ' ms',
        '本轮 HTTP 探测请求：' + s.probeRequests,
        '地址状态：' + s.phase,
        s.detail
      ].join('\n');
      $('error').textContent = '';
    } catch (error) {
      $('status').className = '';
      $('status').textContent = '页面曾连通，当前响应中断';
      $('error').textContent = '请检查接收机上的探测开关、热点及 Showcase 前台状态。' + error.message;
    } finally { clearTimeout(timer); busy = false; }
  }
  check(); setInterval(check, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
})();
