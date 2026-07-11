/* =========================================================================
 * 댄스 동아리(손세상) 연습 일정 분석
 * 단일 파일 SPA — 외부 빌드 도구 없음
 *
 * 모듈 구성 (스크롤로 찾기 쉽게 큰 헤더로 구분)
 *   1. CONFIG
 *   2. API
 *   3. PARSER
 *   4. HOURLY GRID
 *   5. AGGREGATION
 *   6. VALIDATION
 *   7. BOOKINGS (예약/일정 + localStorage 영속화)
 *   8. RENDER
 *   8.5 EXPORT (팀연습 TSV 클립보드 복사)
 *   9. CONTROLLER
 * ========================================================================= */

(function () {
  "use strict";

  // 캐시/배포 버전 확인용 — 콘솔에 찍힙니다. 새 배포가 안 보이면 이 값을 비교하세요.
  const APP_VERSION = "2026-07-09-r12";
  console.log("[app] 댄스 연습 일정 분석 버전:", APP_VERSION);

  /* =======================================================================
   * 1. CONFIG
   * ======================================================================= */

  // ★ 여기를 본인의 Apps Script 웹앱 배포 URL로 바꾸세요.
  // (배포: Apps Script → 배포 → 새 배포 → 웹앱 / 액세스: 모든 사용자)
  const APPS_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbzb3vbAeP0L_bB0_QJ4jvx_kJDmED5aP15vKJAFnifRuiIMN2HLmcdvAkGwe1ibZNB6/exec";

  /* =======================================================================
   * 2. API
   * ======================================================================= */

  async function fetchScheduleData() {
    let res;
    try {
      res = await fetch(APPS_SCRIPT_URL, { method: "GET" });
    } catch (e) {
      throw new Error(
        "네트워크 오류: Apps Script 서버에 연결할 수 없습니다. URL과 인터넷 연결을 확인해 주세요."
      );
    }
    if (!res.ok) {
      throw new Error(`서버 응답 오류 (HTTP ${res.status}). Apps Script 배포 권한을 확인해 주세요.`);
    }
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error("응답을 JSON으로 해석하지 못했습니다. Apps Script가 JSON을 반환하는지 확인해 주세요.");
    }
    if (!data || data.ok !== true) {
      const msg = data && data.error ? data.error : "응답에 ok=true가 없습니다.";
      throw new Error("서버가 오류를 반환했습니다: " + msg);
    }
    return data;
  }

  /* =======================================================================
   * 3. PARSER
   *   가용 시간 표기 → { ranges: [[startMin, endMin], ...], mijeong: bool }
   * ======================================================================= */

  function parseTimeToken(t) {
    if (/^\d{1,2}$/.test(t)) {
      const h = parseInt(t, 10);
      return h * 60;
    }
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    }
    return null;
  }

  function mergeRanges(ranges) {
    if (ranges.length === 0) return ranges;
    ranges.sort((a, b) => a[0] - b[0]);
    const out = [ranges[0].slice()];
    for (let i = 1; i < ranges.length; i++) {
      const last = out[out.length - 1];
      const cur = ranges[i];
      if (cur[0] <= last[1]) {
        last[1] = Math.max(last[1], cur[1]);
      } else {
        out.push(cur.slice());
      }
    }
    return out;
  }

  /**
   * @param raw 원본 셀 문자열
   * @param startMin 분석 범위 시작(분)
   * @param endMin 분석 범위 끝(분)
   * @returns { ranges, mijeong }
   * @throws 잘못된 입력일 때
   */
  // 한글 스프레드시트에서 흔히 섞이는 유사 문자/전각 문자를 정규화한다.
  // (한글 입력기가 자동으로 ~ → 〜, ( → （, : → ：, 13 → １３ 등으로 바꾸는 경우가 많음)
  function normalizeRaw(raw) {
    let s = String(raw);
    // 제로폭/BOM 제거 (U+200B..U+200D, U+FEFF)
    s = s.replace(/[​-‍﻿]/g, "");
    // 각종 대시/하이픈/장음 부호 → '-'
    //   U+2010..U+2015 (하이픈/대시류), U+2212 (마이너스), U+FE58/FE63/FF0D (전각/소형)
    s = s.replace(/[‐-―−﹘﹣－]/g, "-");
    // 각종 물결/웨이브 → '~'
    //   U+223C (∼), U+301C (〜), U+3030 (〰), U+FF5E (～)
    s = s.replace(/[∼〜〰～]/g, "~");
    // 전각 괄호 → 반각
    s = s.replace(/（/g, "(").replace(/）/g, ")");
    // 전각 콜론 → ':'
    s = s.replace(/：/g, ":");
    // 전각/한자 쉼표 → ','
    s = s.replace(/[，、]/g, ",");
    // 전각 숫자 → 반각
    s = s.replace(/[０-９]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30)
    );
    // 전각 영문 O/X
    s = s.replace(/[Ｏｏ]/g, "O").replace(/[Ｘｘ]/g, "X");
    return s;
  }

  function parseAvailability(raw, startMin, endMin) {
    if (raw == null) return { ranges: [], mijeong: false };
    let s = normalizeRaw(raw).replace(/\s+/g, "").replace(/o/g, "O").replace(/x/g, "X");
    if (s === "") return { ranges: [], mijeong: false };

    // 끝의 (미정) 분리
    let mijeong = false;
    const mj = s.match(/^(.*)\(미정\)$/);
    if (mj) {
      mijeong = true;
      s = mj[1];
    }

    // 어딘가 (미정) 또는 잘못된 위치의 미정이 남아있으면 실패
    // 단, 'X' 다음의 (미정)은 위에서 이미 잘림. 'O' 다음의 (미정)도 처리됨.
    // 남은 s 안에 '미정' 토큰이 들어있으면(단, s === '미정' 단독은 허용)
    if (s !== "미정" && s.indexOf("미정") !== -1) {
      throw new Error("잘못된 (미정) 위치: " + raw);
    }

    if (s === "미정") return { ranges: [[startMin, endMin]], mijeong: true };
    if (s === "") return { ranges: [[startMin, endMin]], mijeong: mijeong }; // '(미정)'만 있던 케이스
    if (s === "O") return { ranges: [[startMin, endMin]], mijeong: mijeong };
    if (s === "X") return { ranges: [], mijeong: mijeong };

    // 하이픈 → 물결
    s = s.replace(/-/g, "~");

    const parts = s.split(",");
    const ranges = [];
    for (const p of parts) {
      if (!p) throw new Error("빈 구간: " + raw);
      const tokens = p.split("~");
      if (tokens.length !== 2) {
        throw new Error("올바르지 않은 구간 형식: " + p);
      }
      const [left, right] = tokens;
      const sM = left === "" ? startMin : parseTimeToken(left);
      const eM = right === "" ? endMin : parseTimeToken(right);
      if (sM == null) throw new Error("올바르지 않은 시간: " + left);
      if (eM == null) throw new Error("올바르지 않은 시간: " + right);
      if (sM >= eM) {
        // "~9"(startHour=9), "24~"(endHour=22) 처럼 한쪽 끝이 자동 채움이면서
        // 그 결과로 빈 구간이 되는 경우는 분석 범위 밖 입력이므로 조용히 무시.
        // 그러나 "15~13"처럼 양쪽이 모두 명시된 역순은 명백한 오타이므로 오류로 처리.
        if (left === "" || right === "") continue;
        throw new Error("시작이 끝보다 큼: " + p);
      }

      const cs = Math.max(sM, startMin);
      const ce = Math.min(eM, endMin);
      if (cs < ce) ranges.push([cs, ce]);
    }
    return { ranges: mergeRanges(ranges), mijeong };
  }

  /* =======================================================================
   * 4. HOURLY GRID
   *   1시간 슬롯 펼치기 + 30분 룰
   * ======================================================================= */

  function buildSlots(startHour, endHour) {
    const slots = [];
    for (let h = startHour; h < endHour; h++) {
      slots.push([h * 60, (h + 1) * 60]);
    }
    return slots;
  }

  function formatTime(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h}:00` : `${h}:${String(m).padStart(2, "0")}`;
  }

  // present: 1분이라도 겹치면 true (명단에 표시)
  // available: 30분 이상 겹치면 true (인원수 카운트에 포함)
  // 슬롯 안에서 가용 시간이 분리된 두 구간으로 들어오는 케이스(예: 9:00~9:15,
  // 9:30~9:45)를 union으로 뭉뚱그리지 않고 각 구간 그대로 메모.
  function computeSlotForRanges(ranges, slotStart, slotEnd, mijeong) {
    let total = 0;
    const slices = [];
    for (const [rs, re] of ranges) {
      const is = Math.max(rs, slotStart);
      const ie = Math.min(re, slotEnd);
      if (is < ie) {
        total += ie - is;
        slices.push([is, ie]);
      }
    }
    if (total <= 0) {
      return { present: false, available: false, mijeong, memos: [] };
    }
    // 슬롯 전체를 단일 구간으로 덮으면 메모 생략.
    const fullCoverage =
      slices.length === 1 && slices[0][0] === slotStart && slices[0][1] === slotEnd;
    const memos = [];
    if (!fullCoverage) {
      for (const [is, ie] of slices) {
        const sStr = is === slotStart ? "" : formatTime(is);
        const eStr = ie === slotEnd ? "" : formatTime(ie);
        if (sStr && eStr) memos.push(`${sStr}~${eStr}`);
        else if (sStr) memos.push(`${sStr}~`);
        else memos.push(`~${eStr}`);
      }
    }
    if (mijeong) memos.push("미정");
    return { present: true, available: total >= 30, mijeong, memos };
  }

  function buildHourlyGrid(payload) {
    const { settings, dates, songs, availability } = payload;
    const startMin = settings.startHour * 60;
    const endMin = settings.endHour * 60;
    const slots = buildSlots(settings.startHour, settings.endHour);

    // 모든 곡 멤버를 모음
    const memberSet = new Set();
    for (const song of songs) for (const m of song.members) memberSet.add(m);

    const grid = {}; // grid[member][dateIdx][slotIdx] = { available, mijeong, memos }
    const parseFailures = [];
    for (const m of memberSet) {
      grid[m] = [];
      const memberAvail = availability[m] || {};
      for (let di = 0; di < dates.length; di++) {
        const date = dates[di];
        const raw = memberAvail[date];
        let parsed;
        try {
          parsed = parseAvailability(raw, startMin, endMin);
        } catch (e) {
          parseFailures.push({ member: m, date, raw, error: e.message });
          parsed = { ranges: [], mijeong: false };
        }
        const dayCells = [];
        for (let si = 0; si < slots.length; si++) {
          const [ss, se] = slots[si];
          dayCells.push(computeSlotForRanges(parsed.ranges, ss, se, parsed.mijeong));
        }
        grid[m].push(dayCells);
      }
    }
    if (parseFailures.length) {
      console.warn("[parser] 파싱 실패한 셀 목록:", parseFailures);
    }
    return { grid, slots, parseFailures };
  }

  /* =======================================================================
   * 5. AGGREGATION
   *   곡별 (date, slot) → 가능 멤버 / 인원 / 퍼센트
   * ======================================================================= */

  function aggregateSongs(payload, grid, slots) {
    const { dates, songs } = payload;
    const out = [];
    for (const song of songs) {
      const cells = []; // cells[dateIdx][slotIdx]
      for (let di = 0; di < dates.length; di++) {
        const row = [];
        for (let si = 0; si < slots.length; si++) {
          const members = [];
          for (const m of song.members) {
            const c = grid[m] && grid[m][di] && grid[m][di][si];
            if (c && c.present) {
              members.push({
                name: m,
                mijeong: c.mijeong,
                memos: c.memos,
                low: !c.available, // 1~29분만 가능 → 명단에 표시하되 카운트엔 미포함
              });
            }
          }
          members.sort((a, b) => a.name.localeCompare(b.name, "ko"));
          const count = members.filter((m) => !m.low).length;
          const percent = song.capacity > 0 ? (count / song.capacity) * 100 : 0;
          row.push({ count, percent, members });
        }
        cells.push(row);
      }
      out.push({ song, cells });
    }
    return out;
  }

  /* =======================================================================
   * 6. VALIDATION
   * ======================================================================= */

  function selfValidate(songsData, payload, slots) {
    const { settings, dates, availability } = payload;
    const startMin = settings.startHour * 60;
    const endMin = settings.endHour * 60;
    const errors = [];
    for (const sd of songsData) {
      for (let i = 0; i < 5; i++) {
        if (dates.length === 0 || slots.length === 0) break;
        const di = Math.floor(Math.random() * dates.length);
        const si = Math.floor(Math.random() * slots.length);
        const [ss, se] = slots[si];
        const cell = sd.cells[di][si];
        let recomputed = 0;
        for (const m of sd.song.members) {
          const raw = (availability[m] || {})[dates[di]];
          let parsed;
          try {
            parsed = parseAvailability(raw, startMin, endMin);
          } catch (_) {
            parsed = { ranges: [], mijeong: false };
          }
          let total = 0;
          for (const [rs, re] of parsed.ranges) {
            const is = Math.max(rs, ss);
            const ie = Math.min(re, se);
            if (is < ie) total += ie - is;
          }
          if (total >= 30) recomputed++;
        }
        if (recomputed !== cell.count) {
          errors.push({
            song: sd.song.name,
            date: dates[di],
            slot: `${formatTime(ss)}~${formatTime(se)}`,
            expected: recomputed,
            got: cell.count,
          });
        }
      }
    }
    if (errors.length) {
      console.error("[validation] 자체 검증 불일치:", errors);
    } else {
      console.log("[validation] 자체 검증 통과 (각 곡 5셀씩)");
    }
    return errors;
  }

  /* =======================================================================
   * 7. BOOKINGS
   *   사용자가 셀을 클릭해 잡은 팀 연습 일정. Apps Script(서버)에 POST해서
   *   PropertiesService에 영속화 → 다른 기기에서 새로고침해도 같은 일정 표시.
   *   key 형식: "songName|M/D|hourInt"
   *
   *   자료구조: state.bookings는 Map<key, seq>. seq는 단조증가 시퀀스 번호로,
   *   "예약이 들어온 순서"를 나타낸다. 정렬하면 항상 시간순(=우선권 순). 같은 슬롯에
   *   여러 곡이 같은 멤버를 잡았을 때 seq가 가장 작은(먼저 잡은) 곡이 멤버를 가져간다.
   *
   *   POST 실패 롤백 시에도 그 시점의 seq를 그대로 복원하므로 우선권 자리를 잃지 않음.
   *   POST는 직렬 큐(opChain)에 태워서 응답이 도착 순서와 무관하게 명령 순서대로
   *   처리되도록 보장한다.
   * ======================================================================= */

  function bookingKey(songName, dateShort, slotStartHour) {
    return `${songName}|${dateShort}|${slotStartHour}`;
  }

  // 서버에서 받은 bookings 배열로 state.bookings(Map)를 초기화.
  // 배열 순서를 그대로 seq에 매핑 → 페이지 로드/새로고침 직후엔 서버의 삽입 순서가
  // 우선권 순서가 된다. 이후 사용자가 클라에서 추가/취소를 반복할 때는 ++bookingSeq로
  // 새 번호를 부여하므로, 서버 응답으로 다시 sync될 때까지는 클라 자체의 seq가 권위.
  function syncBookingsFromServer(arr) {
    state.bookings = new Map();
    state.bookingSeq = 0;
    if (!Array.isArray(arr)) return;
    for (const k of arr) {
      if (typeof k !== "string") continue;
      // 중복 방지(서버 응답에 같은 key가 두 번 있으면 무시)
      if (state.bookings.has(k)) continue;
      state.bookings.set(k, state.bookingSeq++);
    }
  }

  // Apps Script web app에 POST. preflight를 피하려고 Content-Type을 text/plain으로.
  // 응답으로 서버의 최신 bookings 배열을 받아서 그대로 반환(상태 sync는 호출자가 결정).
  // action: "add" | "remove" | "clear". clear는 key를 보내지 않는다.
  async function postBookingChange(action, key) {
    const body = { action };
    if (key != null) body.key = key;
    let res;
    try {
      res = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error("네트워크 오류: " + e.message);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error("응답 JSON 파싱 실패");
    }
    if (!data.ok) throw new Error(data.error || "서버가 ok=false 반환");
    return Array.isArray(data.bookings) ? data.bookings : [];
  }

  // 각 (di, si) 셀에서 멤버를 "차지한 곡"을 사전 계산.
  //   result["${di}|${si}"] = Map<memberName, ownerSongName>
  // 선착순 우선: 같은 슬롯의 같은 멤버를 두 곡이 동시에 예약했을 때, seq가 더 작은
  // (먼저 예약된) 곡이 그 멤버를 가져가고, 나머지 곡에서는 "다른 곡에 막힘"으로 처리.
  // bookings는 Map<key, seq> — seq 오름차순으로 정렬해서 우선권 순서를 명시적으로 보장.
  function computeBlockedAt(bookings, songsData, dates, slots) {
    const result = {};
    const songByName = new Map();
    for (const sd of songsData) songByName.set(sd.song.name, sd);
    const dateIndex = new Map();
    for (let i = 0; i < dates.length; i++) {
      dateIndex.set(formatDateShort(dates[i]), i);
    }
    const slotIndex = new Map();
    for (let i = 0; i < slots.length; i++) {
      slotIndex.set(slots[i][0] / 60, i);
    }

    // seq 오름차순 정렬 (작은 seq = 먼저 예약 = 우선권 높음).
    // seq가 같은 경우는 이론상 없지만(단조증가) 안정성을 위해 key 알파벳 순으로 tiebreak.
    const orderedKeys = [...bookings.entries()]
      .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k]) => k);

    for (const key of orderedKeys) {
      // key = "songName|M/D|hourInt" — dateShort/slotHour 포맷이 고정이므로 뒤에서부터 분리.
      const lastSep = key.lastIndexOf("|");
      if (lastSep < 0) continue;
      const firstSep = key.lastIndexOf("|", lastSep - 1);
      if (firstSep < 0) continue;
      const songName = key.slice(0, firstSep);
      const dateShort = key.slice(firstSep + 1, lastSep);
      const slotHour = parseInt(key.slice(lastSep + 1), 10);
      if (!Number.isFinite(slotHour)) continue;

      const sd = songByName.get(songName);
      if (!sd) continue;
      const di = dateIndex.get(dateShort);
      if (di == null) continue;
      const si = slotIndex.get(slotHour);
      if (si == null) continue;
      const cell = sd.cells[di] && sd.cells[di][si];
      if (!cell) continue;

      const cellKey = `${di}|${si}`;
      if (!result[cellKey]) result[cellKey] = new Map();
      const ownerMap = result[cellKey];
      for (const mi of cell.members) {
        // 이미 더 먼저 들어온 예약이 이 멤버를 차지했다면 그대로 둔다(선착순).
        if (!ownerMap.has(mi.name)) ownerMap.set(mi.name, songName);
      }
    }
    return result;
  }

  /* =======================================================================
   * 8. RENDER
   * ======================================================================= */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getCellColor(count, capacity, threshold) {
    if (count === 0) return { bg: "#FFFFFF", fg: "transparent", dim: true };
    const percent = capacity > 0 ? (count / capacity) * 100 : 0;
    if (percent < threshold) {
      return { bg: "#ECF0F1", fg: "#7F8C8D", dim: true };
    }
    if (percent >= 100) return { bg: "#C0392B", fg: "#FFFFFF" };
    if (percent >= 90) return { bg: "#E67E22", fg: "#FFFFFF" };
    if (percent >= 75) return { bg: "#F1C40F", fg: "#000000" };
    if (percent >= 60) return { bg: "#82C341", fg: "#000000" };
    if (percent >= 50) return { bg: "#5DADE2", fg: "#000000" };
    return { bg: "#AED6F1", fg: "#1B4F72" };
  }

  function getWeekday(startDateStr, idx) {
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    if (!startDateStr) return "";
    const d = new Date(startDateStr + "T00:00:00");
    if (isNaN(d.getTime())) return "";
    d.setDate(d.getDate() + idx);
    return days[d.getDay()];
  }

  // dates[i]는 "5/8" 같은 짧은 형식으로 오기도 하고, Apps Script에서 Date 객체가
  // 직렬화되며 "Fri May 08 2026 09:00:00 GMT+0900 (한국 표준시)" 같은 긴 형식으로
  // 오기도 한다. 화면 헤더에서는 항상 "M/D"로 보여주기 위해 정규화.
  function formatDateShort(raw) {
    if (raw == null) return "";
    const s = String(raw).trim();
    if (s === "") return "";
    if (/^\d{1,2}\/\d{1,2}$/.test(s)) return s;
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }
    return s;
  }

  function memberBadge(mi) {
    const memoText = mi.memos.length ? `(${mi.memos.join(",")})` : "";
    const text = escapeHtml(mi.name + memoText);
    const classes = [];
    if (mi.low) classes.push("m-low");
    if (mi.blocked) classes.push("m-blocked");
    const inner = classes.length ? `<span class="${classes.join(" ")}">${text}</span>` : text;
    // 막힌 멤버 옆에 차단한 곡 이름을 작게 표기 (취소선 바깥에 두어 줄 안 그어지게).
    if (mi.blocked && mi.blockedBy) {
      return `${inner}<span class="m-blocked-by">(${escapeHtml(mi.blockedBy)})</span>`;
    }
    return inner;
  }

  function renderHeatmaps(songsData, dates, slots, settings, threshold, viewMode, bookings, blockedAt) {
    const root = document.getElementById("heatmaps");
    root.innerHTML = "";
    if (!songsData.length) {
      root.innerHTML = '<p class="empty">표시할 곡이 없습니다.</p>';
      return;
    }
    for (const sd of songsData) {
      const card = document.createElement("section");
      card.className = "song-card";

      const header = document.createElement("div");
      header.className = "song-header";
      header.innerHTML = `
        <h3>${escapeHtml(sd.song.name)}</h3>
        <span class="capacity-badge">정원 ${sd.song.capacity}명</span>
      `;
      card.appendChild(header);

      const table = buildHeatmapTable(sd, dates, slots, settings, threshold, viewMode, bookings, blockedAt);
      card.appendChild(table);

      const summary = buildSongSummary(sd, dates, slots);
      card.appendChild(summary);

      root.appendChild(card);
    }
  }

  function buildHeatmapTable(sd, dates, slots, settings, threshold, view, bookings, blockedAt) {
    const wrap = document.createElement("div");
    wrap.className = "heatmap-wrap";
    const tbl = document.createElement("table");
    tbl.className = "heatmap" + (view === "B" ? " heatmap-detailed" : "");
    let html = "<thead><tr><th class='corner'>시간 \\ 날짜</th>";
    for (let di = 0; di < dates.length; di++) {
      html += `<th>${escapeHtml(formatDateShort(dates[di]))}<span class="wd">(${getWeekday(
        settings.startDate,
        di
      )})</span></th>`;
    }
    html += "</tr></thead><tbody>";

    const cap = sd.song.capacity;
    for (let si = 0; si < slots.length; si++) {
      const [ss, se] = slots[si];
      const slotHour = ss / 60;
      html += `<tr><th class="slot-label">${formatTime(ss)}~${formatTime(se)}</th>`;
      for (let di = 0; di < dates.length; di++) {
        const cell = sd.cells[di][si];
        const dateShort = formatDateShort(dates[di]);
        const isBooked = bookings.has(bookingKey(sd.song.name, dateShort, slotHour));

        // 선착순 우선: 멤버 owner가 다른 곡이면 막힘. 같은 슬롯에 두 곡이 동시 예약돼도
        // 멤버는 한 명이므로 먼저 잡은 곡(owner)만 카운트하고, 나머지 곡 셀에서는 깎인다.
        const blockedMap = blockedAt[`${di}|${si}`];
        const blockedNames = new Set();
        const blockedBy = new Map(); // memberName -> 차단한 곡명
        const blockerCounts = new Map(); // 차단한 곡명 -> 깎인 인원 수(low 제외)
        let blockedAvailableCount = 0;
        if (blockedMap) {
          for (const mi of cell.members) {
            const owner = blockedMap.get(mi.name);
            if (owner && owner !== sd.song.name) {
              blockedNames.add(mi.name);
              blockedBy.set(mi.name, owner);
              if (!mi.low) {
                blockedAvailableCount++;
                blockerCounts.set(owner, (blockerCounts.get(owner) || 0) + 1);
              }
            }
          }
        }
        const effectiveCount = cell.count - blockedAvailableCount;
        // 차단 곡 요약: "곡A 2, 곡B 1" 형식. 가나다순 정렬.
        const blockerSummaryHtml = blockerCounts.size > 0
          ? `<div class="blocker-summary">${
              [...blockerCounts.entries()]
                .sort((a, b) => a[0].localeCompare(b[0], "ko"))
                .map(([s, n]) => `${escapeHtml(s)} ${n}`)
                .join(", ")
            }</div>`
          : "";

        // effective가 0이지만 표시할 내용(strikethrough된 원래 카운트, 막힌 멤버,
        // 또는 1~29분만 가능한 low 멤버 명단 등)이 있는 셀은 getCellColor의 기본
        // fg=transparent로는 글자가 안 보임 → dim 색으로 강제 보정.
        let color = getCellColor(effectiveCount, cap, threshold);
        if (effectiveCount === 0 && cell.members.length > 0) {
          color = { bg: "#ECF0F1", fg: "#7F8C8D", dim: true };
        }
        const style = `background:${color.bg};color:${color.fg};`;
        const cellClass = `cell${view === "B" ? " cell-detail" : ""}${isBooked ? " cell-booked" : ""}`;
        const dataAttrs = ` data-song="${escapeHtml(sd.song.name)}" data-date="${escapeHtml(dateShort)}" data-slot-start="${slotHour}"`;

        let countDisplay = "";
        if (cell.count > 0) {
          countDisplay = effectiveCount !== cell.count
            ? `<s>${cell.count}/${cap}</s>${effectiveCount}/${cap}`
            : `${cell.count}/${cap}`;
        }

        if (view === "A") {
          // 카운트 + (있으면) 차단 곡 요약을 세로로. 차단이 없는 셀은 기존처럼 카운트만.
          const inner = blockerSummaryHtml
            ? `<div class="cell-count">${countDisplay}</div>${blockerSummaryHtml}`
            : countDisplay;
          html += `<td class="${cellClass}" style="${style}"${dataAttrs}>${inner}</td>`;
        } else {
          const memberHtml = cell.members
            .map((m) => memberBadge({
              ...m,
              blocked: blockedNames.has(m.name),
              blockedBy: blockedBy.get(m.name),
            }))
            .join(", ");
          html += `<td class="${cellClass}" style="${style}"${dataAttrs}>
            <div class="cell-count">${countDisplay}</div>
            ${blockerSummaryHtml}
            <div class="cell-members">${memberHtml}</div>
          </td>`;
        }
      }
      html += "</tr>";
    }
    html += "</tbody>";
    tbl.innerHTML = html;
    wrap.appendChild(tbl);
    return wrap;
  }

  function buildSongSummary(sd, dates, slots) {
    const div = document.createElement("div");
    div.className = "song-summary";

    // 멤버별 미정 날짜 수집 (그 날 1슬롯이라도 mijeong이면 그 날을 미정으로).
    // 부분 참여 정보는 셀 안에 이미 (~HH:MM)/(HH:MM~)로 표시되므로 여기서는 제외.
    const mijeongMap = {}; // member -> Set(date)
    for (let di = 0; di < dates.length; di++) {
      for (let si = 0; si < slots.length; si++) {
        const cell = sd.cells[di][si];
        for (const mi of cell.members) {
          if (mi.mijeong) {
            if (!mijeongMap[mi.name]) mijeongMap[mi.name] = new Set();
            mijeongMap[mi.name].add(dates[di]);
          }
        }
      }
    }
    let html = "";
    const mEntries = Object.entries(mijeongMap)
      .sort((a, b) => a[0].localeCompare(b[0], "ko"));
    if (mEntries.length) {
      html += '<div class="summary-block"><strong>미정 멤버:</strong> ';
      html += mEntries
        .map(
          ([n, ds]) =>
            `${escapeHtml(n)}(${[...ds].map((d) => escapeHtml(formatDateShort(d))).join(", ")})`
        )
        .join(" · ");
      html += "</div>";
    }
    if (!html) html = '<div class="summary-block muted">미정 멤버 없음</div>';
    div.innerHTML = html;
    return div;
  }

  function showAlert(message) {
    const banner = document.getElementById("alert-banner");
    banner.textContent = message;
    banner.classList.remove("hidden");
  }
  function hideAlert() {
    const banner = document.getElementById("alert-banner");
    banner.classList.add("hidden");
  }

  /* =======================================================================
   * 8.5 EXPORT — 잡은 팀연습을 TSV로 클립보드 복사
   *   sonsesang2026 스프레드시트 형식(A:날짜 B:시작시각 C:종료시각 D:곡명
   *   E:연습실(비움) F:참여부원) 그대로. 대상 시트 A2에 붙여넣으면 셀별로
   *   들어간다. 헤더 행은 포함하지 않는다(2행 이하에 붙여넣는 용도).
   *
   *   규칙:
   *   - 같은 곡·같은 날의 연속된 시간 예약은 한 행으로 병합 (14시+15시 → 14~16)
   *   - 참여부원은 히트맵과 동일한 30분 룰 적용 (블록과 30분 미만 겹침은 제외)
   *   - 다른 곡이 선착순으로 차지한 멤버는 그 시간대를 뺀 나머지로 재계산
   *   - 부분 참여 메모는 병합 블록 기준으로 재계산: 이름(15~), 이름(~16:30),
   *     이름(14:30~15:30), 미정은 이름(미정) / 이름(15~,미정) 형태
   * ======================================================================= */

  // "H" 또는 "H:MM" — 시트 입력 규격과 동일하게 정각이면 ":00" 생략
  function fmtHM(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? String(h) : `${h}:${String(m).padStart(2, "0")}`;
  }

  // ranges에서 [s, e) 구간을 뺀 결과를 반환 (원본 불변)
  function subtractRange(ranges, s, e) {
    const out = [];
    for (const [rs, re] of ranges) {
      if (re <= s || rs >= e) {
        out.push([rs, re]);
        continue;
      }
      if (rs < s) out.push([rs, s]);
      if (re > e) out.push([e, re]);
    }
    return out;
  }

  // 병합 블록 기준으로 멤버 한 명의 참여 표기를 계산.
  // computeSlotForRanges와 같은 30분 룰이되, 블록이 1시간이 아닐 수 있고
  // 다른 곡에 뺏긴 시간을 뺀 effective ranges를 입력으로 받는다.
  // 참여 불가(30분 미만)면 null.
  function exportMemberEntry(name, effRanges, blockStart, blockEnd, mijeong) {
    let total = 0;
    const slices = [];
    for (const [rs, re] of effRanges) {
      const is = Math.max(rs, blockStart);
      const ie = Math.min(re, blockEnd);
      if (is < ie) {
        total += ie - is;
        slices.push([is, ie]);
      }
    }
    if (total < 30) return null;
    const fullCoverage =
      slices.length === 1 && slices[0][0] === blockStart && slices[0][1] === blockEnd;
    const memos = [];
    if (!fullCoverage) {
      for (const [is, ie] of slices) {
        const sStr = is === blockStart ? "" : fmtHM(is);
        const eStr = ie === blockEnd ? "" : fmtHM(ie);
        if (sStr && eStr) memos.push(`${sStr}~${eStr}`);
        else if (sStr) memos.push(`${sStr}~`);
        else memos.push(`~${eStr}`);
      }
    }
    if (mijeong) memos.push("미정");
    return memos.length ? `${name}(${memos.join(",")})` : name;
  }

  // di번째 날짜를 "YYYY. M. D" 문자열로. 연도는 설정의 startDate에서 추론하며,
  // 조사 기간이 해를 넘기는 경우(12월→1월)도 처리. 붙여넣기 시 구글 시트가
  // 날짜로 자동 인식하는 형식.
  function exportDateString(di, settings, dates) {
    const md = formatDateShort(dates[di]);
    const base =
      settings && settings.startDate ? new Date(settings.startDate + "T00:00:00") : null;
    const baseValid = base && !isNaN(base.getTime());
    const m = md.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (m && baseValid) {
      let year = base.getFullYear();
      if (parseInt(m[1], 10) < base.getMonth() + 1) year += 1;
      return `${year}. ${parseInt(m[1], 10)}. ${parseInt(m[2], 10)}`;
    }
    if (baseValid) {
      const d = new Date(base);
      d.setDate(d.getDate() + di);
      return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}`;
    }
    return md;
  }

  // 예약 Map → 내보내기 행 목록. 날짜 → 시작시각 → 곡명 순 정렬.
  // 현재 payload와 매칭되지 않는 예약(곡/날짜가 사라진 stale key)은 skipped로 집계.
  function buildExportRows(bookings, payload, songsData, slots) {
    const { settings, dates, availability } = payload;
    const startMin = settings.startHour * 60;
    const endMin = settings.endHour * 60;

    const dateIndex = new Map();
    for (let i = 0; i < dates.length; i++) dateIndex.set(formatDateShort(dates[i]), i);
    const slotIndex = new Map();
    for (let i = 0; i < slots.length; i++) slotIndex.set(slots[i][0] / 60, i);
    const songByName = new Map();
    for (const sd of songsData) songByName.set(sd.song.name, sd);

    const blockedAt = computeBlockedAt(bookings, songsData, dates, slots);

    // 곡|날짜 단위로 예약 시각 모으기
    const groups = new Map();
    let skipped = 0;
    for (const key of bookings.keys()) {
      const lastSep = key.lastIndexOf("|");
      const firstSep = lastSep < 0 ? -1 : key.lastIndexOf("|", lastSep - 1);
      if (firstSep < 0) {
        skipped++;
        continue;
      }
      const songName = key.slice(0, firstSep);
      const dateShort = key.slice(firstSep + 1, lastSep);
      const hour = parseInt(key.slice(lastSep + 1), 10);
      const di = dateIndex.get(dateShort);
      if (!songByName.has(songName) || di == null || !slotIndex.has(hour)) {
        skipped++;
        continue;
      }
      const gk = `${songName}|${dateShort}`;
      if (!groups.has(gk)) groups.set(gk, { songName, di, hours: [] });
      groups.get(gk).hours.push(hour);
    }

    const rows = [];
    for (const g of groups.values()) {
      const song = songByName.get(g.songName).song;
      // 연속된 시각을 [시작시, 종료시) 블록으로 병합
      const hours = [...new Set(g.hours)].sort((a, b) => a - b);
      const runs = [];
      for (const h of hours) {
        const last = runs[runs.length - 1];
        if (last && h === last[1]) last[1] = h + 1;
        else runs.push([h, h + 1]);
      }

      for (const [h0, h1] of runs) {
        const blockStart = h0 * 60;
        const blockEnd = h1 * 60;
        const entries = [];
        for (const member of song.members) {
          const raw = (availability[member] || {})[dates[g.di]];
          let parsed;
          try {
            parsed = parseAvailability(raw, startMin, endMin);
          } catch (_) {
            parsed = { ranges: [], mijeong: false };
          }
          // 다른 곡이 선착순으로 차지한 시간대는 뺀다 (히트맵의 취소선과 동일 기준)
          let eff = parsed.ranges;
          for (let h = h0; h < h1; h++) {
            const ownerMap = blockedAt[`${g.di}|${slotIndex.get(h)}`];
            const owner = ownerMap && ownerMap.get(member);
            if (owner && owner !== g.songName) {
              eff = subtractRange(eff, h * 60, (h + 1) * 60);
            }
          }
          const entry = exportMemberEntry(member, eff, blockStart, blockEnd, parsed.mijeong);
          if (entry) entries.push(entry);
        }
        entries.sort((a, b) => a.localeCompare(b, "ko"));
        rows.push({
          di: g.di,
          startHour: h0,
          endHour: h1,
          songName: g.songName,
          membersStr: entries.join(" "),
        });
      }
    }

    rows.sort(
      (a, b) =>
        a.di - b.di ||
        a.startHour - b.startHour ||
        a.songName.localeCompare(b.songName, "ko")
    );
    return { rows, skipped };
  }

  function buildTsv(rows, settings, dates) {
    return rows
      .map((r) =>
        [
          exportDateString(r.di, settings, dates),
          String(r.startHour),
          String(r.endHour),
          r.songName,
          "", // 연습실은 따로 잡으므로 비워둠
          r.membersStr,
        ].join("\t")
      )
      .join("\n");
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        /* 폴백으로 진행 */
      }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (_) {}
    document.body.removeChild(ta);
    return ok;
  }

  async function exportBookingsTsv() {
    if (!state.payload || !state.songsData) {
      showAlert("데이터가 아직 로드되지 않았습니다.");
      return;
    }
    if (state.bookings.size === 0) {
      showAlert("내보낼 팀 연습 일정이 없습니다. 히트맵 셀을 클릭해 먼저 일정을 잡아 주세요.");
      return;
    }
    const { rows, skipped } = buildExportRows(
      state.bookings,
      state.payload,
      state.songsData,
      state.slots
    );
    if (!rows.length) {
      showAlert(`내보낼 수 있는 일정이 없습니다 (현재 데이터와 맞지 않는 예약 ${skipped}건).`);
      return;
    }
    if (skipped) {
      console.warn(`[export] 현재 데이터와 매칭되지 않아 제외된 예약 ${skipped}건`);
    }
    const tsv = buildTsv(rows, state.payload.settings, state.payload.dates);
    const ok = await copyTextToClipboard(tsv);
    if (!ok) {
      showAlert("클립보드 복사에 실패했습니다. 브라우저 권한을 확인해 주세요.");
      return;
    }
    const btn = document.getElementById("export-tsv-btn");
    if (btn) {
      const original = "팀연습 TSV 복사";
      btn.textContent = `복사 완료 ✓ ${rows.length}행`;
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 2000);
    }
  }

  /* =======================================================================
   * 9. CONTROLLER
   * ======================================================================= */

  const state = {
    payload: null,
    grid: null,
    slots: null,
    songsData: null,
    threshold: 60,
    viewMode: "A", // "A" 인원수만, "B" 상세 명단
    bookings: new Map(), // Map<key, seq>. seq 오름차순 = 예약 시간순 = 우선권 순.
    bookingSeq: 0,        // 단조증가 시퀀스 카운터.
  };

  // 예약 변경 POST 직렬화 큐. 사용자가 빠르게 연속 클릭해도 서버에 도달하는 순서가
  // 보장되고, 응답이 도착 순서와 무관하게 명령 순서대로 처리된다.
  let opChain = Promise.resolve();
  let pendingOps = 0;

  async function loadAndRender() {
    hideAlert();
    const loading = document.getElementById("loading");
    const errorBox = document.getElementById("error");
    loading.classList.remove("hidden");
    errorBox.classList.add("hidden");
    document.getElementById("heatmaps").innerHTML = "";

    try {
      const payload = await fetchScheduleData();
      state.payload = payload;
      // 시트의 thresholdPercent 셀이 비었거나 잘못 들어온 경우 60으로 기본값 보정.
      const t = Number(payload.settings && payload.settings.thresholdPercent);
      state.threshold = Number.isFinite(t) ? t : 60;

      // 슬라이더 동기화
      const slider = document.getElementById("threshold-slider");
      const tval = document.getElementById("threshold-value");
      slider.value = state.threshold;
      tval.textContent = state.threshold;

      const { grid, slots, parseFailures } = buildHourlyGrid(payload);
      state.grid = grid;
      state.slots = slots;
      state.songsData = aggregateSongs(payload, grid, slots);
      // 서버에서 내려온 예약 목록으로 동기화 — 단, 진행 중인 POST가 있었다면
      // payload.bookings는 그 POST가 반영되기 전 스냅샷이라 stale.
      // → 진행 중 op들이 끝날 때까지 기다리고, 그 동안 op들이 자체 sync했을
      // 것이므로 payload.bookings로 덮어쓰지 않는다.
      const hadPendingOps = pendingOps > 0;
      await opChain.catch(() => {});
      if (!hadPendingOps) {
        syncBookingsFromServer(payload.bookings);
      }

      // 자체 검증 — 계산 불일치 또는 파싱 실패가 있으면 배너로 즉시 알림.
      // 파싱 실패는 데이터(스프레드시트) 오타일 가능성이 높으므로 반드시 노출.
      const errs = selfValidate(state.songsData, payload, slots);
      if (errs.length) {
        showAlert(
          `자체 검증 불일치 ${errs.length}건이 발견되었습니다. 콘솔에서 자세한 내용을 확인하세요.`
        );
      } else if (parseFailures.length) {
        showAlert(
          `파싱 실패 셀 ${parseFailures.length}건이 있습니다. 해당 항목은 "불가"로 처리됩니다 (콘솔 참고).`
        );
      }

      // 마지막 업데이트
      const lu = document.getElementById("last-updated");
      const updatedAt = payload.generatedAt ? new Date(payload.generatedAt) : new Date();
      lu.textContent = "마지막 업데이트: " + updatedAt.toLocaleString("ko-KR");

      rerender();
      // 디버그용 노출
      window.__test = {
        payload: state.payload,
        grid: state.grid,
        slots: state.slots,
        songsData: state.songsData,
        parseAvailability,
        computeSlotForRanges,
        buildExportRows,
        buildTsv,
        exportDateString,
        subtractRange,
        exportMemberEntry,
      };
    } catch (e) {
      console.error(e);
      errorBox.textContent = "데이터를 불러오지 못했습니다: " + e.message;
      errorBox.classList.remove("hidden");
    } finally {
      loading.classList.add("hidden");
    }
  }

  function rerender() {
    if (!state.songsData) return;
    const blockedAt = computeBlockedAt(
      state.bookings,
      state.songsData,
      state.payload.dates,
      state.slots
    );
    renderHeatmaps(
      state.songsData,
      state.payload.dates,
      state.slots,
      state.payload.settings,
      state.threshold,
      state.viewMode,
      state.bookings,
      blockedAt
    );
  }

  function bindControls() {
    document.getElementById("refresh-btn").addEventListener("click", loadAndRender);
    document.getElementById("reset-bookings-btn").addEventListener("click", clearAllBookings);
    document.getElementById("export-tsv-btn").addEventListener("click", exportBookingsTsv);

    const slider = document.getElementById("threshold-slider");
    const tval = document.getElementById("threshold-value");
    slider.addEventListener("input", (e) => {
      state.threshold = parseInt(e.target.value, 10);
      tval.textContent = state.threshold;
      rerender();
    });

    document.querySelectorAll(".view-mode-toggle .toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll(".view-mode-toggle .toggle-btn")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.viewMode = btn.dataset.view;
        rerender();
      });
    });

    // 셀 클릭으로 예약 토글 (이벤트 위임 — 표는 매 렌더마다 갈리지만 #heatmaps는 그대로).
    // 동작:
    //  1) 클릭 시점에 즉시 optimistic 업데이트 + rerender (즉각 피드백).
    //  2) POST는 opChain에 직렬 추가 → 응답이 도착 순서와 무관하게 명령 순서대로 처리.
    //  3) 큐가 비었을 때만 서버 응답으로 state sync → 중간 응답으로 인한 깜빡임 방지.
    //  4) 실패 시: 추가 실패면 그 key만 삭제. 취소 실패면 prevSeq로 정확히 복원
    //     → 우선권 자리를 잃지 않음.
    document.getElementById("heatmaps").addEventListener("click", (e) => {
      const td = e.target.closest("td.cell[data-song]");
      if (!td) return;
      const slotHour = parseInt(td.dataset.slotStart, 10);
      if (!Number.isFinite(slotHour)) return;
      const key = bookingKey(td.dataset.song, td.dataset.date, slotHour);
      toggleBooking(key);
    });
  }

  // 예약 토글. 클릭 시점의 (action, prevSeq)를 캡처하고 optimistic 업데이트를 적용한 뒤
  // POST를 직렬 큐에 추가한다. 실패 시 캡처해둔 prevSeq로 정확히 복원.
  function toggleBooking(key) {
    const wasBooked = state.bookings.has(key);
    const action = wasBooked ? "remove" : "add";
    const prevSeq = wasBooked ? state.bookings.get(key) : null;

    // 1) Optimistic 적용 (post-increment로 sync 헬퍼와 카운터 의미를 통일)
    if (wasBooked) {
      state.bookings.delete(key);
    } else {
      state.bookings.set(key, state.bookingSeq++);
    }
    rerender();

    // 2) POST를 직렬 큐에 추가. try/catch는 postBookingChange만 감싸서
    //    이후 sync/rerender의 예외가 catch로 떨어져 pendingOps가 중복 감소되는 것을 방지.
    pendingOps++;
    opChain = opChain.then(async () => {
      let arr;
      try {
        arr = await postBookingChange(action, key);
      } catch (err) {
        pendingOps--;
        // 이 작업만 롤백. 다른 진행 중 POST는 그대로 진행되며, 그 응답이 마지막일 때
        // 서버에서 sync되면서 최종 일관성이 회복된다(서버는 이 실패한 명령을 모르므로
        // 서버 상태가 곧 정답).
        if (wasBooked) {
          // 취소 실패 → 원래 자리(prevSeq)로 복원. 단, 그 사이 다른 경로로 이미
          // 같은 key가 다시 추가됐다면(예: 중간 sync) 덮어쓰지 않음.
          if (!state.bookings.has(key) && prevSeq != null) {
            state.bookings.set(key, prevSeq);
          }
        } else {
          // 추가 실패 → optimistic으로 넣었던 key 제거.
          state.bookings.delete(key);
        }
        rerender();
        showAlert("예약 저장 실패: " + (err && err.message ? err.message : err));
        return;
      }
      // POST 성공: 모든 진행 중 POST가 끝났을 때만 서버 응답으로 sync.
      // 중간에 sync하면 다른 in-flight 작업의 optimistic 상태가 사라져 깜빡임 발생.
      pendingOps--;
      if (pendingOps === 0) {
        syncBookingsFromServer(arr);
        rerender();
      }
    });
  }

  // 전체 초기화: 사용자 confirm을 받은 뒤 직렬 큐에 clearAll POST를 추가.
  // 직전에 큐에 들어간 add/remove들이 모두 처리된 다음 clearAll이 서버에서 실행되므로
  // 경합이 자연스럽게 해소된다(즉 큐 직렬화 덕분에 clearAll은 항상 최후 수행).
  // optimistic UI를 쓰지 않는 이유: 실패 시 "복원해야 하는 정확한 상태"를 알기 어렵기
  // 때문(다른 in-flight op들과 엮인 시점에서). 서버 응답을 기다린 뒤 sync하는 게 안전.
  function clearAllBookings() {
    const count = state.bookings.size;
    if (count === 0) {
      showAlert("초기화할 팀 연습 일정이 없습니다.");
      return;
    }
    const confirmed = window.confirm(
      `현재 등록된 모든 팀 연습 일정 ${count}건을 초기화합니다.\n\n` +
      `이 작업은 되돌릴 수 없습니다. 정말 진행하시겠습니까?`
    );
    if (!confirmed) return;

    const btn = document.getElementById("reset-bookings-btn");
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "초기화 중...";

    pendingOps++;
    opChain = opChain.then(async () => {
      let arr;
      try {
        arr = await postBookingChange("clear", null);
      } catch (err) {
        pendingOps--;
        btn.disabled = false;
        btn.textContent = originalLabel;
        showAlert("전체 초기화 실패: " + (err && err.message ? err.message : err));
        return;
      }
      pendingOps--;
      btn.disabled = false;
      btn.textContent = originalLabel;
      // 다른 in-flight op의 optimistic 상태를 덮어쓰지 않도록 큐가 비었을 때만 sync.
      if (pendingOps === 0) {
        syncBookingsFromServer(arr);
        rerender();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindControls();
    if (APPS_SCRIPT_URL.includes("REPLACE_WITH_YOUR_DEPLOYMENT_ID")) {
      const errorBox = document.getElementById("error");
      errorBox.innerHTML =
        "Apps Script URL이 설정되어 있지 않습니다. <code>app.js</code> 상단의 <code>APPS_SCRIPT_URL</code>을 본인의 배포 URL로 바꿔 주세요.";
      errorBox.classList.remove("hidden");
      document.getElementById("loading").classList.add("hidden");
      return;
    }
    loadAndRender();
  });
})();
