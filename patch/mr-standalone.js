/*!
 * Mineradio iOS 独立版 · 本地桥接层
 * ---------------------------------------------------------------
 * 作用：没有 Node 后端的情况下，把 H5 发出的 /api/* 请求在应用内部实现：
 *   1. 通过原生插件（URLSession）直连网易云公开接口 —— 无 CORS、带 Cookie 会话
 *   2. 浏览器调试环境自动退化为普通 fetch（配合 --disable-web-security）
 *   3. 音频/封面直连 CDN（CDN 自带 CORS，可视化不受影响）
 *
 * 版权：逻辑参考 Mineradio-Android (GPL-3.0) 与 Mineradio 桌面版的服务端响应格式。
 */
(function () {
  'use strict';

  if (window.__MR_STANDALONE__) return;
  window.__MR_STANDALONE__ = true;

  // ---------- 资源直连（独立版无需本地代理） ----------
  window.MRAudioProxy = function (u) { return u ? String(u) : ''; };
  window.MRCoverProxy = function (u) { return u ? String(u) : ''; };

  // 登录面板的彩蛋门槛：独立版首次启动直接放行（口令「世界和平」等价）
  try { localStorage.setItem('mineradio-login-easter-egg-browser-preview-v1', '1'); } catch (e) { }

  // ---------- 基础 ----------
  var NE = 'https://music.163.com';
  var UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  var BASE_HEADERS = {
    'Referer': NE + '/',
    'Origin': NE,
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  };

  function httpsify(u) {
    if (!u) return '';
    return String(u).replace(/^http:\/\//i, 'https://');
  }

  function nativePlugin() {
    var cap = window.Capacitor;
    return (cap && cap.Plugins && cap.Plugins.Mineradio) || null;
  }

  function cookiesPlugin() {
    var cap = window.Capacitor;
    return (cap && cap.Plugins && cap.Plugins.CapacitorCookies) || null;
  }

  // 写入登录 Cookie：优先自定义原生插件（URLSession 会话），其次官方 CapacitorCookies
  function cookieStoreSet(cookieStr) {
    var plugin = nativePlugin();
    if (plugin && typeof plugin.setCookies === 'function') {
      return plugin.setCookies({ cookie: cookieStr, domain: '.music.163.com' }).catch(function () { });
    }
    var cp = cookiesPlugin();
    if (!cp || typeof cp.setCookie !== 'function') return Promise.resolve();
    var tasks = [];
    String(cookieStr || '').split(';').forEach(function (pair) {
      var kv = pair.split('=');
      if (kv.length < 2) return;
      var k = kv[0].trim();
      var v = kv.slice(1).join('=').trim();
      if (!k) return;
      tasks.push(cp.setCookie({ url: 'https://music.163.com', key: k, value: v }).catch(function () { }));
    });
    return Promise.all(tasks);
  }

  function cookieStoreClear() {
    var plugin = nativePlugin();
    if (plugin && typeof plugin.clearCookies === 'function') {
      return plugin.clearCookies({ domain: 'music.163.com' }).catch(function () { });
    }
    var cp = cookiesPlugin();
    if (cp && typeof cp.clearAllCookies === 'function') {
      return cp.clearAllCookies().catch(function () { });
    }
    return Promise.resolve();
  }

  // 原生 HTTP（App 内）或普通 fetch（浏览器调试）
  function nativeHttp(url, opts) {
    opts = opts || {};
    var plugin = nativePlugin();
    var headers = opts.headers || BASE_HEADERS;
    if (plugin && typeof plugin.httpRequest === 'function') {
      return plugin.httpRequest({
        url: url,
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body || null
      }).then(function (res) {
        return { status: (res && res.status) || 0, text: (res && res.body) || '' };
      });
    }
    var init = { method: opts.method || 'GET', headers: headers, credentials: 'omit' };
    if (opts.body) init.body = opts.body;
    return fetch(url, init).then(function (r) {
      return r.text().then(function (t) { return { status: r.status, text: t }; });
    });
  }

  function httpJson(url, opts) {
    return nativeHttp(url, opts).then(function (r) {
      if (!r.text) throw new Error('empty response (' + r.status + ')');
      try { return JSON.parse(r.text); } catch (e) { throw new Error('bad json: ' + String(r.text).slice(0, 80)); }
    });
  }

  function neGet(path) { return httpJson(NE + path); }
  function nePost(path) { return httpJson(NE + path, { method: 'POST', body: '' }); }

  // ---------- 数据映射（与桌面/安卓版服务端输出字段保持一致） ----------
  function mapSong(s) {
    s = s || {};
    var artists = (s.artists || s.ar || []).map(function (a) { return { id: a && a.id, name: (a && a.name) || '' }; });
    var album = s.album || s.al || {};
    var cover = album.picUrl || album.coverUrl || (album.artist && album.artist.picUrl) || '';
    return {
      provider: 'netease',
      source: 'netease',
      type: 'song',
      id: s.id,
      name: s.name || '',
      artist: artists.map(function (a) { return a.name; }).join(' / '),
      artists: artists,
      artistId: artists[0] && artists[0].id,
      album: album.name || '',
      albumId: album.id || '',
      cover: httpsify(cover),
      duration: s.duration || s.dt || 0,
      popularity: Number(s.pop || s.popularity || s.score || s.hotScore) || 100,
      searchRank: null,
      fee: (s.fee === undefined || s.fee === null) ? 0 : s.fee
    };
  }

  function qualityToBr(q) {
    if (q === 'jymaster' || q === 'hires') return 999000;
    if (q === 'lossless') return 999000;
    if (q === 'exhigh') return 320000;
    if (q === 'higher') return 192000;
    return 128000;
  }
  function brToLevel(br) {
    if (br >= 900000) return 'lossless';
    if (br >= 320000) return 'exhigh';
    if (br >= 192000) return 'higher';
    return 'standard';
  }

  // ---------- 登录态缓存 ----------
  var accountState = { loggedIn: false, checkedAt: 0, profile: null };

  function vipFields(p) {
    var vipType = (p && p.vipType) || 0;
    return {
      vipType: vipType,
      vipLevel: vipType >= 10 ? 'svip' : (vipType > 0 ? 'vip' : 'none'),
      isVip: vipType > 0,
      isSvip: vipType >= 10,
      vipLabel: vipType >= 10 ? 'SVIP' : (vipType > 0 ? 'VIP' : '无VIP')
    };
  }

  // ---------- API 实现 ----------
  var HANDLERS = {
    '/api/search': function (p) {
      var kw = p.get('keywords') || '';
      var limit = parseInt(p.get('limit') || '20', 10) || 20;
      var offset = parseInt(p.get('offset') || '0', 10) || 0;
      var provider = p.get('provider') || 'netease';
      if (provider !== 'netease') return Promise.resolve({ songs: [], offset: offset, limit: limit, nextOffset: offset, hasMore: false });
      return neGet('/api/search/get/web?s=' + encodeURIComponent(kw) + '&type=1&limit=' + limit + '&offset=' + offset)
        .then(function (d) {
          var raw = (d.result && d.result.songs) || [];
          var songs = raw.map(mapSong);
          return { songs: songs, offset: offset, limit: limit, nextOffset: offset + songs.length, hasMore: songs.length >= limit };
        });
    },

    '/api/song/url': function (p) {
      var id = p.get('id');
      var quality = p.get('quality') || 'exhigh';
      var br = qualityToBr(quality);
      return neGet('/api/song/enhance/player/url?ids=%5B' + encodeURIComponent(id) + '%5D&br=' + br)
        .then(function (d) {
          var item = (d.data || [])[0] || {};
          var url = httpsify(item.url || '');
          return {
            provider: 'netease',
            source: 'netease',
            url: url,
            trial: !!item.freeTrialInfo,
            playable: !!url,
            level: brToLevel(item.br || br),
            quality: brToLevel(item.br || br),
            br: item.br || br,
            requestedQuality: quality,
            size: item.size || 0,
            md5: item.md5 || '',
            code: item.code || 200,
            loggedIn: accountState.loggedIn
          };
        });
    },

    '/api/lyric': function (p) {
      var id = p.get('id');
      return neGet('/api/song/lyric?id=' + encodeURIComponent(id) + '&lv=-1&kv=-1&tv=-1&rv=-1')
        .then(function (d) {
          return {
            lyric: (d.lrc && d.lrc.lyric) || '',
            tlyric: (d.tlyric && d.tlyric.lyric) || '',
            klyric: (d.klyric && d.klyric.lyric) || '',
            romalrc: (d.romalrc && d.romalrc.lyric) || '',
            yrc: '',
            ytlrc: '',
            yromalrc: '',
            source: 'lyric'
          };
        });
    },

    '/api/song/detail': function (p) {
      var id = p.get('id') || p.get('ids');
      return neGet('/api/song/detail?ids=%5B' + encodeURIComponent(String(id).replace(/[\[\]]/g, '')) + '%5D')
        .then(function (d) { return { songs: (d.songs || []).map(mapSong) }; });
    },

    // ---------- 登录 ----------
    '/api/login/status': function () {
      if (Date.now() - accountState.checkedAt < 5000 && accountState.profile) {
        return Promise.resolve(accountState.profile);
      }
      return neGet('/api/nuser/account/get').then(function (d) {
        var p = d.profile || null;
        var out;
        if (p && p.userId) {
          out = Object.assign({
            loggedIn: true,
            userId: p.userId,
            nickname: p.nickname,
            avatarUrl: httpsify(p.avatarUrl),
            hasCookie: true
          }, vipFields(p));
        } else {
          out = Object.assign({ loggedIn: false, hasCookie: false, userId: 0, nickname: '', avatarUrl: '' }, vipFields(null));
        }
        accountState.loggedIn = out.loggedIn;
        accountState.profile = out;
        accountState.checkedAt = Date.now();
        return out;
      });
    },

    '/api/login/qr/key': function () {
      return nePost('/api/login/qrcode/unikey?type=1').then(function (d) {
        if (!d.unikey) throw new Error('unikey failed: ' + JSON.stringify(d).slice(0, 120));
        return { key: d.unikey, code: 200 };
      });
    },

    '/api/login/qr/create': function (p) {
      var key = p.get('key') || '';
      var content = NE + '/login?codekey=' + key;
      var img = '';
      try {
        if (typeof qrcode === 'function') {
          var qr = qrcode(0, 'M');
          qr.addData(content);
          qr.make();
          img = qr.createDataURL(6, 12);
        }
      } catch (e) { img = ''; }
      return Promise.resolve({ img: img, qrurl: content, code: 200 });
    },

    '/api/login/qr/check': function (p) {
      var key = p.get('key') || '';
      return nePost('/api/login/qrcode/client/login?type=1&key=' + encodeURIComponent(key)).then(function (d) {
        var out = { code: d.code };
        if (d.code === 803) {
          out.loggedIn = true;
          out.hasCookie = true;
          out.nickname = d.nickname || '';
          out.avatarUrl = httpsify(d.avatarUrl || '');
          accountState.checkedAt = 0; // 下次强制刷新
          // 登录成功：把返回的 cookie 写入原生会话（VIP 曲目播放需要）
          if (d.cookie) cookieStoreSet(d.cookie);
        }
        return out;
      });
    },

    '/api/login/cookie': function (p, init) {
      var cookie = '';
      try {
        if (init && init.body) {
          var b = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
          cookie = b.cookie || b.ck || '';
        }
      } catch (e) { }
      if (!cookie) cookie = p.get('cookie') || '';
      if (!cookie) return Promise.resolve({ ok: false, error: 'cookie_unavailable' });
      return cookieStoreSet(cookie).then(function () {
        accountState.checkedAt = 0;
        return HANDLERS['/api/login/status'](new URLSearchParams());
      });
    },

    '/api/logout': function () {
      return cookieStoreClear().then(function () {
        accountState = { loggedIn: false, checkedAt: 0, profile: null };
        return { ok: true, loggedIn: false };
      });
    },

    // ---------- 静态能力声明 ----------
    '/api/platform/capabilities': function () {
      return Promise.resolve({
        platform: 'ios-standalone',
        serverReady: true,
        netease: { playlists: true, likeRead: true, likeWrite: false, albumRead: true, albumCollect: false, commentsRead: true, commentsWrite: false, listenReport: false },
        qq: { playlists: false, likeRead: false, likeWrite: false, albumRead: false, albumCollect: false, commentsRead: false, commentsWrite: false, listenReport: false },
        kugou: { playlists: false, likeRead: false, likeWrite: false, albumRead: false, albumCollect: false, commentsRead: false, commentsWrite: false, listenReport: false },
        qishui: { playlists: false, likeRead: false, likeWrite: false, albumRead: false, albumCollect: false, commentsRead: false, commentsWrite: false, listenReport: false },
        spotify: { playlists: false, likeRead: false, likeWrite: false, albumRead: false, albumCollect: false, commentsRead: false, commentsWrite: false, listenReport: false }
      });
    },

    '/api/app/version': function () {
      return Promise.resolve({ version: '2.1.0-ios', platform: 'ios', code: 200 });
    },

    '/api/plugins/list': function () {
      return Promise.resolve({ ok: true, plugins: [] });
    },

    // ---------- 安全降级（保持界面可用） ----------
    '/api/user/playlists': function () { return Promise.resolve({ playlist: [], more: false }); },
    '/api/playlist/tracks': function () { return Promise.resolve({ playlist: { tracks: [] } }); },
    '/api/qq/login/status': function () { return Promise.resolve({ code: -1, message: 'not supported on ios standalone' }); },
    '/api/kugou/login/status': function () { return Promise.resolve({ ok: false, logged_in: false }); },
    '/api/qishui/status': function () { return Promise.resolve({ ok: false, logged_in: false }); },
    '/api/spotify/status': function () { return Promise.resolve({ ok: false, logged_in: false }); },
    '/api/discover/home': function () { return Promise.resolve({ blocks: [] }); },
    '/api/listen/total': function () { return Promise.resolve({ total: 0 }); },
    '/api/cache/storage-stats': function () { return Promise.resolve({ ok: true, totalBytes: 0 }); },
    '/api/weather/ip-location': function () { return Promise.resolve({ ok: false, city: '' }); },
    '/api/weather/radio': function () { return Promise.resolve({ ok: false }); }
  };

  var DEFAULT_503 = { code: 503, message: 'service_unavailable', error: 'not implemented in ios standalone build' };

  function jsonResponse(obj, status) {
    return Promise.resolve({ status: status || 200, body: JSON.stringify(obj) });
  }

  function handleApi(pathname, params, init) {
    var fn = HANDLERS[pathname];
    if (!fn) {
      // 未实现：返回 503，让前端走 try/catch 优雅降级
      console.log('[MR-API] 503 (unimplemented):', pathname);
      return jsonResponse(DEFAULT_503, 503);
    }
    return Promise.resolve()
      .then(function () { return fn(params, init); })
      .then(function (data) {
        console.log('[MR-API] 200', pathname, JSON.stringify(data).slice(0, 220));
        return { status: 200, body: JSON.stringify(data) };
      })
      .catch(function (err) {
        console.log('[MR-API] 500', pathname, String((err && err.message) || err).slice(0, 220));
        return { status: 500, body: JSON.stringify({ code: 500, error: String((err && err.message) || err) }) };
      });
  }

  // ---------- fetch 拦截 ----------
  var originalFetch = window.fetch;

  window.fetch = function (input, init) {
    var u = '';
    try { u = (typeof input === 'string') ? input : ((input && input.url) || ''); } catch (e) { }
    if (u && u.charAt(0) === '/') {
      var qi = u.indexOf('?');
      var pathname = qi >= 0 ? u.slice(0, qi) : u;
      if (pathname.indexOf('/api/') === 0) {
        var params = new URLSearchParams(qi >= 0 ? u.slice(qi + 1) : '');
        return handleApi(pathname, params, init).then(function (r) {
          return new Response(r.body, {
            status: r.status,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
          });
        });
      }
    }
    return originalFetch.apply(window, arguments);
  };

  console.log('[Mineradio] standalone bridge ready (ios build)');
})();
