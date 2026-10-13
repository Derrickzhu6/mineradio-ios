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
  function cookieStoreSet(cookieStr, domain) {
    domain = domain || '.music.163.com';
    var siteUrl = domain.indexOf('qq.com') >= 0 ? 'https://y.qq.com' : 'https://music.163.com';
    var plugin = nativePlugin();
    if (plugin && typeof plugin.setCookies === 'function') {
      return plugin.setCookies({ cookie: cookieStr, domain: domain }).catch(function () { });
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
      tasks.push(cp.setCookie({ url: siteUrl, key: k, value: v }).catch(function () { }));
    });
    return Promise.all(tasks);
  }

  function cookieStoreClear(domain) {
    domain = domain || 'music.163.com';
    var plugin = nativePlugin();
    if (plugin && typeof plugin.clearCookies === 'function') {
      return plugin.clearCookies({ domain: domain }).catch(function () { });
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

  // ================================================================
  //  QQ 音乐（公开接口 + 官方签名算法，参考 Mineradio/Mineradio-Android 实现）
  // ================================================================

  var QQ_UA = 'QQMusic 14090508(android 12)';
  var QQ_HEADERS = { 'Referer': 'https://y.qq.com/', 'User-Agent': QQ_UA, 'Content-Type': 'application/json;charset=UTF-8' };
  var QQ_COMM = {
    ct: '11', cv: '14090508', v: '14090508', tmeAppID: 'qqmusic', phonetype: 'EBG-AN10', os_ver: '12',
    OpenUDID: '0', QIMEI36: '0', udid: '0', chid: '0', aid: '0', oaid: '0', taid: '0', tid: '0', wid: '0',
    uid: '0', sid: '0', modeSwitch: '6', teenMode: '0', ui_mode: '2', nettype: '1020'
  };
  var QQ_QUALITY_FILES = [
    { prefix: 'M800', ext: '.mp3', level: 'exhigh' },
    { prefix: 'M500', ext: '.mp3', level: 'standard' },
    { prefix: 'C400', ext: '.m4a', level: 'aac' },
    { prefix: 'F000', ext: '.flac', level: 'lossless' }
  ];

  var qqState = { uin: '', key: '' };

  function qqStateFromCookie(cookie) {
    var st = { uin: '', key: '' };
    String(cookie || '').split(';').forEach(function (pair) {
      var kv = pair.split('=');
      var k = (kv[0] || '').trim();
      var v = kv.slice(1).join('=').trim();
      if (k === 'uin' || k === 'qqmusic_uin') st.uin = v.replace(/^o0*/, '').replace(/\D/g, '') || v;
      if (k === 'qqmusic_key' || k === 'qm_keyst') st.key = v;
    });
    return st;
  }

  // ---- SHA-1（纯 JS，避免依赖 crypto.subtle 的安全上下文限制） ----
  function sha1Hex(str) {
    function rotl(n, s) { return (n << s) | (n >>> (32 - s)); }
    var utf8 = unescape(encodeURIComponent(str));
    var bytes = [];
    for (var i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i) & 255);
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
    bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    var w = new Array(80);
    for (var off = 0; off < bytes.length; off += 64) {
      for (var i2 = 0; i2 < 16; i2++) {
        w[i2] = (bytes[off + i2 * 4] << 24) | (bytes[off + i2 * 4 + 1] << 16) | (bytes[off + i2 * 4 + 2] << 8) | bytes[off + i2 * 4 + 3];
      }
      for (var i3 = 16; i3 < 80; i3++) w[i3] = rotl(w[i3 - 3] ^ w[i3 - 8] ^ w[i3 - 14] ^ w[i3 - 16], 1);
      var a = h0, b = h1, c = h2, d = h3, e = h4;
      for (var i4 = 0; i4 < 80; i4++) {
        var f, k;
        if (i4 < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
        else if (i4 < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (i4 < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        var tmp = (rotl(a, 5) + f + e + k + w[i4]) >>> 0;
        e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    function hex(n) { var s = (n >>> 0).toString(16); while (s.length < 8) s = '0' + s; return s; }
    return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
  }

  // ---- QQ 官方签名（与 Mineradio 服务端 qqSearchSign 等价） ----
  function qqSign(text) {
    var h = sha1Hex(text);
    function ch(i) { return (i >= 0 && i < h.length) ? h.charAt(i) : ''; }
    var part1 = [23, 14, 6, 36, 16, 40, 7, 19].map(ch).join('');
    var part2 = [16, 1, 32, 12, 19, 27, 8, 5].map(ch).join('');
    var scramble = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];
    var bins = '';
    for (var i = 0; i < scramble.length; i++) {
      bins += String.fromCharCode(scramble[i] ^ parseInt(h.substr(i * 2, 2), 16));
    }
    var middle = '';
    try { middle = btoa(bins).replace(/[\/+=]/g, ''); } catch (e) { middle = ''; }
    return ('zzc' + part1 + middle + part2).toLowerCase();
  }

  function qqPostJson(url, payload) {
    var bodyText = JSON.stringify(payload);
    var headers = {};
    for (var k in QQ_HEADERS) headers[k] = QQ_HEADERS[k];
    headers['Content-Length'] = String(bodyText.length);
    return nativeHttp(url, { method: 'POST', headers: headers, body: bodyText })
      .then(function (r) { return JSON.parse(r.text); });
  }

  function qqCover(albumMid, size) {
    if (!albumMid) return '';
    var px = size || 300;
    return 'https://y.qq.com/music/photo_new/T002R' + px + 'x' + px + 'M000' + albumMid + '.jpg?max_age=2592000';
  }

  function mapQQTrack(track) {
    track = track || {};
    var album = track.album || {};
    var artists = (track.singer || []).map(function (a) {
      return { id: a && a.id, mid: a && a.mid, name: (a && a.name) || '' };
    }).filter(function (a) { return a.name; });
    var mid = track.mid || '';
    var albumMid = album.mid || album.pmid || '';
    return {
      provider: 'qq', source: 'qq', type: 'qq',
      id: mid, qqId: track.id || '', mid: mid, songmid: mid,
      mediaMid: (track.file && track.file.media_mid) || '',
      name: track.name || track.title || '',
      artist: artists.map(function (a) { return a.name; }).join(' / '),
      artists: artists,
      artistId: artists[0] && artists[0].id,
      artistMid: artists[0] && artists[0].mid,
      album: album.name || album.title || '',
      albumMid: albumMid,
      cover: qqCover(albumMid, 300),
      duration: (Number(track.interval) || 0) * 1000,
      popularity: 60,
      fee: (track.pay && Number(track.pay.pay_play)) ? 1 : 0,
      playable: false
    };
  }

  function qqSearchSongs(kw, limit, offset) {
    var pageNumber = Math.floor(offset / limit) + 1;
    var payload = {
      comm: QQ_COMM,
      req: {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicMobile',
        param: {
          search_type: 0,
          searchid: String(Date.now()) + String(Math.random()).slice(2, 8),
          query: kw, page_num: pageNumber, num_per_page: limit,
          highlight: 0, nqc_flag: 0, multi_zhida: 0, cat: 2, grp: 1, sin: offset, sem: 0
        }
      }
    };
    var bodyText = JSON.stringify(payload);
    var url = 'https://u.y.qq.com/cgi-bin/musics.fcg?sign=' + qqSign(bodyText);
    var headers = {};
    for (var k in QQ_HEADERS) headers[k] = QQ_HEADERS[k];
    headers['Content-Length'] = String(bodyText.length);
    return nativeHttp(url, { method: 'POST', headers: headers, body: bodyText }).then(function (r) {
      var d = JSON.parse(r.text);
      var data = (d.req && d.req.data) || {};
      var b = data.body || data;
      var items = b.item_song || (b.song && b.song.list) || b.list || [];
      return items.map(function (it) {
        return mapQQTrack(it.track_info || it.songInfo || it.song || it);
      }).filter(function (s) { return s.name && s.mid; });
    });
  }

  function qqSongUrl(mid, mediaMid) {
    var guid = String(10000000 + Math.floor(Math.random() * 90000000));
    var filenames = [];
    [mediaMid, mid].forEach(function (m) {
      if (!m) return;
      QQ_QUALITY_FILES.forEach(function (q) { filenames.push(q.prefix + m + q.ext); });
    });
    if (!filenames.length) return Promise.resolve({ url: '' });
    var uin = qqState.uin || '0';
    var comm = { uin: uin, format: 'json', ct: qqState.key ? 19 : 24, cv: 0 };
    if (qqState.key) comm.authst = qqState.key;
    var payload = {
      comm: comm,
      req_0: {
        module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
        param: {
          guid: guid, songmid: filenames.map(function () { return mid; }),
          songtype: filenames.map(function () { return 0; }),
          uin: uin, loginflag: 1, platform: '20', filename: filenames
        }
      }
    };
    return qqPostJson('https://u.y.qq.com/cgi-bin/musicu.fcg', payload).then(function (d) {
      var r0 = (d.req_0 && d.req_0.data) || {};
      var sip = (r0.sip && r0.sip.length) ? r0.sip[0] : 'https://ws.stream.qqmusic.qq.com/';
      var infos = r0.midurlinfo || [];
      var lastCode = 0;
      for (var i = 0; i < infos.length; i++) {
        var info = infos[i];
        if (info && info.purl) {
          var level = 'standard';
          var fn = String(info.filename || '');
          for (var j = 0; j < QQ_QUALITY_FILES.length; j++) {
            if (fn.indexOf(QQ_QUALITY_FILES[j].prefix) === 0) { level = QQ_QUALITY_FILES[j].level; break; }
          }
          return { url: sip + info.purl, level: level, filename: fn };
        }
        lastCode = (info && info.result) || lastCode;
      }
      return { url: '', result: lastCode };
    });
  }

  function qqLyric(mid) {
    var url = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=' + encodeURIComponent(mid) + '&format=json&nobase64=1';
    // 注意：歌词接口要浏览器 UA，QQMusic 客户端 UA 会被拒（返回空）
    var headers = {
      'Referer': 'https://y.qq.com/portal/player.html',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    };
    return nativeHttp(url, { headers: headers })
      .then(function (r) {
        var d = JSON.parse(r.text);
        return {
          provider: 'qq',
          lyric: d.lyric || '',
          tlyric: d.trans || '',
          yrc: '', ytlrc: '', romalrc: '', yromalrc: '',
          source: 'qq'
        };
      });
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

    // ---------- QQ 音乐 ----------
    '/api/qq/search': function (p) {
      var kw = p.get('keywords') || '';
      var limit = Math.max(4, Math.min(30, parseInt(p.get('limit') || '12', 10) || 12));
      var offset = Math.max(0, parseInt(p.get('offset') || '0', 10) || 0);
      if (!kw) return Promise.resolve({ provider: 'qq', songs: [], offset: offset, limit: limit, nextOffset: offset, hasMore: false });
      return qqSearchSongs(kw, limit, offset).then(function (songs) {
        return { provider: 'qq', songs: songs, offset: offset, limit: limit, nextOffset: offset + songs.length, hasMore: songs.length >= limit };
      });
    },

    '/api/qq/song/url': function (p) {
      var mid = p.get('mid') || p.get('songmid') || p.get('id') || '';
      var mediaMid = p.get('mediaMid') || p.get('media_mid') || '';
      if (!mid) return Promise.resolve({ provider: 'qq', url: '', playable: false, error: 'MISSING_MID', message: '缺少歌曲 mid' });
      return qqSongUrl(mid, mediaMid).then(function (r) {
        if (r.url) {
          return {
            provider: 'qq', url: r.url, trial: false, playable: true, playbackReady: true,
            level: r.level || 'standard', quality: r.level || 'standard',
            loggedIn: !!qqState.uin, userId: qqState.uin || '',
            playbackKeyReady: !!qqState.key, vipRequired: false
          };
        }
        var loggedIn = !!qqState.uin;
        return {
          provider: 'qq', url: '', playable: false, trial: false,
          reason: loggedIn ? 'vip_required' : 'login_required',
          message: loggedIn
            ? 'QQ 音乐：该歌曲需要会员权限（当前账号未识别到会员状态）'
            : 'QQ 音乐：该歌曲需要登录后播放，可在登录面板粘贴 QQ 音乐 Cookie',
          loggedIn: loggedIn, userId: qqState.uin || '', result: r.result || 0
        };
      });
    },

    '/api/qq/lyric': function (p) {
      var mid = p.get('mid') || p.get('songmid') || p.get('id') || '';
      if (!mid) return Promise.resolve({ provider: 'qq', lyric: '', tlyric: '' });
      return qqLyric(mid);
    },

    '/api/qq/login/cookie': function (p, init) {
      var cookie = '';
      try {
        if (init && init.body) {
          var b = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
          cookie = b.cookie || b.data || b.text || '';
        }
      } catch (e) { }
      if (!cookie) cookie = p.get('cookie') || '';
      if (!cookie) return Promise.resolve({ code: -1, ok: false, loggedIn: false, message: 'cookie 为空' });
      return cookieStoreSet(cookie, '.qq.com').then(function () {
        var st = qqStateFromCookie(cookie);
        qqState.uin = st.uin || qqState.uin;
        qqState.key = st.key || qqState.key;
        var loggedIn = !!(qqState.uin && qqState.key);
        return {
          code: 0, ok: loggedIn, loggedIn: loggedIn, hasCookie: loggedIn,
          uin: qqState.uin, nickname: 'QQ 音乐用户',
          playbackKeyReady: !!qqState.key,
          vipType: 0, vipLevel: 'unknown', isVip: false, isSvip: false, vipLabel: '会员状态待验证',
          message: loggedIn ? '' : 'cookie 里没找到 uin / qqmusic_key，请粘贴完整 Cookie'
        };
      });
    },

    '/api/qq/login/status': function () {
      var loggedIn = !!(qqState.uin && qqState.key);
      return Promise.resolve({
        code: 0, ok: true, loggedIn: loggedIn, hasCookie: loggedIn,
        uin: qqState.uin || '', nickname: loggedIn ? 'QQ 音乐用户' : '',
        playbackKeyReady: !!qqState.key,
        vipType: 0, vipLevel: 'unknown', isVip: false, isSvip: false, vipLabel: '会员状态待验证'
      });
    },

    '/api/qq/logout': function () {
      var uin = qqState.uin;
      qqState.uin = ''; qqState.key = '';
      var done = uin ? cookieStoreClear('qq.com') : Promise.resolve();
      return done.then(function () { return { code: 0, ok: true, loggedIn: false }; });
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
