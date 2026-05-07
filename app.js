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
 *   6. CANDIDATES
 *   7. VALIDATION
 *   8. RENDER
 *   9. CONTROLLER
 * ========================================================================= */

(function () {
  "use strict";

  /* =======================================================================
   * 1. CONFIG
   * ======================================================================= */

  // ★ 여기를 본인의 Apps Script 웹앱 배포 URL로 바꾸세요.
  // (배포: Apps Script → 배포 → 새 배포 → 웹앱 / 액세스: 모든 사용자)
  const APPS_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbzb3vbAeP0L_bB0_QJ4jvx_kJDmED5aP15vKJAFnifRuiIMN2HLmcdvAkGwe1ibZNB6/exec";

  // 후보 슬롯 점수화/렌더링에 영향을 주는 기본값
  const DEFAULTS = {
    duration: "both", // "2" | "3" | "both"
    maxCandidatesPerSong: 12,
  };

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
      if (sM >= eM) throw new Error("시작이 끝보다 큼: " + p);

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

  function computeSlotForRanges(ranges, slotStart, slotEnd, mijeong) {
    let total = 0;
    let unionStart = null;
    let unionEnd = null;
    for (const [rs, re] of ranges) {
      const is = Math.max(rs, slotStart);
      const ie = Math.min(re, slotEnd);
      if (is < ie) {
        total += ie - is;
        if (unionStart == null || is < unionStart) unionStart = is;
        if (unionEnd == null || ie > unionEnd) unionEnd = ie;
      }
    }
    if (total < 30) {
      return { available: false, mijeong, memos: [] };
    }
    const memos = [];
    if (unionStart > slotStart) memos.push(`${formatTime(unionStart)}부터`);
    if (unionEnd < slotEnd) memos.push(`~${formatTime(unionEnd)}까지`);
    if (mijeong) memos.push("미정");
    return { available: true, mijeong, memos };
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
            if (c && c.available) {
              members.push({ name: m, mijeong: c.mijeong, memos: c.memos });
            }
          }
          const count = members.length;
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
   * 6. CANDIDATES
   *   연습 시간 후보 도출 + 점수화
   * ======================================================================= */

  function findCandidatesForSong(songData, dates, slots, threshold, durations) {
    const out = [];
    const D = dates.length;
    const S = slots.length;
    for (let di = 0; di < D; di++) {
      for (const dur of durations) {
        for (let si = 0; si + dur <= S; si++) {
          // dur개 연속 슬롯 모두 가능한 멤버 교집합
          let intersection = null; // Map(name -> { mijeongAny, partialAny })
          for (let k = 0; k < dur; k++) {
            const cell = songData.cells[di][si + k];
            if (k === 0) {
              intersection = new Map();
              for (const mi of cell.members) {
                intersection.set(mi.name, {
                  mijeongAny: !!mi.mijeong,
                  partialAny: mi.memos.some((x) => x !== "미정"),
                });
              }
            } else {
              const slotMap = new Map(cell.members.map((m) => [m.name, m]));
              for (const name of [...intersection.keys()]) {
                if (!slotMap.has(name)) {
                  intersection.delete(name);
                } else {
                  const mi = slotMap.get(name);
                  const info = intersection.get(name);
                  if (mi.mijeong) info.mijeongAny = true;
                  if (mi.memos.some((x) => x !== "미정")) info.partialAny = true;
                }
              }
            }
            if (intersection.size === 0) break;
          }
          const cap = songData.song.capacity;
          const count = intersection.size;
          if (count === 0) continue;
          const percent = cap > 0 ? (count / cap) * 100 : 0;
          if (percent < threshold) continue;

          const memberList = [...intersection.entries()].map(([name, info]) => ({
            name,
            ...info,
          }));
          memberList.sort((a, b) => a.name.localeCompare(b.name, "ko"));
          const mijeongCount = memberList.filter((m) => m.mijeongAny).length;
          const partialCount = memberList.filter((m) => m.partialAny).length;
          const presentNames = new Set(memberList.map((m) => m.name));
          const missingMembers = songData.song.members.filter((m) => !presentNames.has(m));

          out.push({
            songName: songData.song.name,
            capacity: cap,
            dateIdx: di,
            date: dates[di],
            slotIdx: si,
            duration: dur,
            startMin: slots[si][0],
            endMin: slots[si + dur - 1][1],
            count,
            percent,
            members: memberList,
            mijeongCount,
            partialCount,
            missingMembers,
          });
        }
      }
    }
    out.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.duration !== a.duration) return b.duration - a.duration;
      if (a.mijeongCount !== b.mijeongCount) return a.mijeongCount - b.mijeongCount;
      if (a.partialCount !== b.partialCount) return a.partialCount - b.partialCount;
      if (a.dateIdx !== b.dateIdx) return a.dateIdx - b.dateIdx;
      return a.startMin - b.startMin;
    });
    return out;
  }

  /* =======================================================================
   * 7. VALIDATION
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
    if (percent < threshold || percent < 50) {
      return { bg: "#ECF0F1", fg: "#7F8C8D", dim: true };
    }
    if (percent >= 100) return { bg: "#C0392B", fg: "#FFFFFF" };
    if (percent >= 90) return { bg: "#E67E22", fg: "#FFFFFF" };
    if (percent >= 75) return { bg: "#F1C40F", fg: "#000000" };
    if (percent >= 60) return { bg: "#82C341", fg: "#000000" };
    if (percent >= 50) return { bg: "#5DADE2", fg: "#000000" };
    return { bg: "#ECF0F1", fg: "#7F8C8D", dim: true };
  }

  function getWeekday(startDateStr, idx) {
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    if (!startDateStr) return "";
    const d = new Date(startDateStr + "T00:00:00");
    if (isNaN(d.getTime())) return "";
    d.setDate(d.getDate() + idx);
    return days[d.getDay()];
  }

  function memberBadge(mi) {
    const memoText = mi.memos.length ? `(${mi.memos.join(", ")})` : "";
    return `<span class="member-chip${mi.mijeong ? " mijeong" : ""}${
      mi.memos.some((x) => x !== "미정") ? " partial" : ""
    }">${escapeHtml(mi.name)}${escapeHtml(memoText)}</span>`;
  }

  function renderHeatmaps(songsData, dates, slots, settings, threshold) {
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
        <div class="view-toggle" role="group">
          <button class="toggle-btn active" data-view="A">인원수만</button>
          <button class="toggle-btn" data-view="B">상세 명단</button>
          <button class="toggle-btn" data-view="AB">둘 다</button>
        </div>
      `;
      card.appendChild(header);

      const tableA = buildHeatmapTable(sd, dates, slots, settings, threshold, "A");
      const tableB = buildHeatmapTable(sd, dates, slots, settings, threshold, "B");
      tableA.dataset.view = "A";
      tableB.dataset.view = "B";
      tableB.style.display = "none";
      card.appendChild(tableA);
      card.appendChild(tableB);

      // 미정/부분참여 요약
      const summary = buildSongSummary(sd, dates, slots);
      card.appendChild(summary);

      // 토글 핸들러
      header.querySelectorAll(".toggle-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          header.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          const view = btn.dataset.view;
          tableA.style.display = view === "B" ? "none" : "";
          tableB.style.display = view === "A" ? "none" : "";
        });
      });

      root.appendChild(card);
    }
  }

  function buildHeatmapTable(sd, dates, slots, settings, threshold, view) {
    const wrap = document.createElement("div");
    wrap.className = "heatmap-wrap";
    const tbl = document.createElement("table");
    tbl.className = "heatmap" + (view === "B" ? " heatmap-detailed" : "");
    let html = "<thead><tr><th class='corner'>시간 \\ 날짜</th>";
    for (let di = 0; di < dates.length; di++) {
      html += `<th>${escapeHtml(dates[di])}<br><span class="wd">(${getWeekday(
        settings.startDate,
        di
      )})</span></th>`;
    }
    html += "</tr></thead><tbody>";

    for (let si = 0; si < slots.length; si++) {
      const [ss, se] = slots[si];
      html += `<tr><th class="slot-label">${formatTime(ss)}~${formatTime(se)}</th>`;
      for (let di = 0; di < dates.length; di++) {
        const cell = sd.cells[di][si];
        const color = getCellColor(cell.count, sd.song.capacity, threshold);
        const style = `background:${color.bg};color:${color.fg};`;
        const countLabel = cell.count > 0 ? cell.count : "";
        if (view === "A") {
          html += `<td class="cell" style="${style}">${countLabel}</td>`;
        } else {
          const memberHtml = cell.members.map(memberBadge).join(" ");
          html += `<td class="cell cell-detail" style="${style}">
            <div class="cell-count">${countLabel}</div>
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

    // 멤버별 미정 날짜 수집 (그 날 1슬롯이라도 mijeong이면 그 날을 미정으로)
    const mijeongMap = {}; // member -> Set(date)
    const partialMap = {}; // member -> [{date, slot, memos}]
    for (let di = 0; di < dates.length; di++) {
      for (let si = 0; si < slots.length; si++) {
        const cell = sd.cells[di][si];
        for (const mi of cell.members) {
          if (mi.mijeong) {
            if (!mijeongMap[mi.name]) mijeongMap[mi.name] = new Set();
            mijeongMap[mi.name].add(dates[di]);
          }
          const partial = mi.memos.filter((x) => x !== "미정");
          if (partial.length) {
            if (!partialMap[mi.name]) partialMap[mi.name] = [];
            partialMap[mi.name].push({
              date: dates[di],
              slot: `${formatTime(slots[si][0])}~${formatTime(slots[si][1])}`,
              memo: partial.join(", "),
            });
          }
        }
      }
    }
    let html = "";
    const mEntries = Object.entries(mijeongMap);
    if (mEntries.length) {
      html += '<div class="summary-block"><strong>미정 멤버:</strong> ';
      html += mEntries
        .map(([n, dates]) => `${escapeHtml(n)}(${[...dates].map(escapeHtml).join(", ")})`)
        .join(" · ");
      html += "</div>";
    }
    const pEntries = Object.entries(partialMap);
    if (pEntries.length) {
      html += '<div class="summary-block"><strong>부분 참여:</strong> ';
      html += pEntries
        .map(([n, infos]) => {
          const items = infos.map((i) => `${i.date} ${i.slot} ${i.memo}`).join("; ");
          return `${escapeHtml(n)} — ${escapeHtml(items)}`;
        })
        .join(" · ");
      html += "</div>";
    }
    if (!html) html = '<div class="summary-block muted">미정/부분 참여 없음</div>';
    div.innerHTML = html;
    return div;
  }

  function renderCandidates(songsData, dates, slots, settings, threshold, durationMode) {
    const root = document.getElementById("candidates");
    root.innerHTML = "";
    const durations = durationMode === "both" ? [2, 3] : [parseInt(durationMode, 10)];

    for (const sd of songsData) {
      const card = document.createElement("section");
      card.className = "song-card";
      card.innerHTML = `<div class="song-header"><h3>${escapeHtml(
        sd.song.name
      )}</h3><span class="capacity-badge">정원 ${sd.song.capacity}명</span></div>`;
      const list = document.createElement("div");
      list.className = "candidate-list";

      const candidates = findCandidatesForSong(sd, dates, slots, threshold, durations).slice(
        0,
        DEFAULTS.maxCandidatesPerSong
      );
      if (!candidates.length) {
        list.innerHTML = '<p class="empty">임계값을 만족하는 후보가 없습니다.</p>';
      } else {
        for (const c of candidates) {
          list.appendChild(renderCandidateCard(c, settings));
        }
      }
      card.appendChild(list);
      root.appendChild(card);
    }
  }

  function renderCandidateCard(c, settings) {
    const div = document.createElement("article");
    div.className = "candidate-card";
    const wd = getWeekday(settings.startDate, c.dateIdx);
    const color = getCellColor(c.count, c.capacity, 0); // 후보는 임계값 통과한 것이므로 0
    const memberChips = c.members
      .map(
        (m) =>
          `<span class="member-chip${m.mijeongAny ? " mijeong" : ""}${
            m.partialAny ? " partial" : ""
          }">${escapeHtml(m.name)}${m.mijeongAny ? "(미정)" : ""}${
            m.partialAny ? "(부분)" : ""
          }</span>`
      )
      .join(" ");
    const missingChips = c.missingMembers
      .map((m) => `<span class="member-chip missing">${escapeHtml(m)}</span>`)
      .join(" ");

    div.innerHTML = `
      <div class="cand-head" style="border-left:6px solid ${color.bg};">
        <div class="cand-title">
          <span class="cand-date">${escapeHtml(c.date)} (${wd})</span>
          <span class="cand-time">${formatTime(c.startMin)} ~ ${formatTime(c.endMin)}</span>
          <span class="cand-dur">${c.duration}시간</span>
        </div>
        <div class="cand-badge" style="background:${color.bg};color:${color.fg};">
          ${c.count}/${c.capacity} (${c.percent.toFixed(0)}%)
        </div>
      </div>
      <details class="cand-details" open>
        <summary>참여 멤버 ${c.count}명${c.mijeongCount ? ` · 미정 ${c.mijeongCount}` : ""}${
      c.partialCount ? ` · 부분 ${c.partialCount}` : ""
    }</summary>
        <div class="cand-members">${memberChips || '<span class="muted">없음</span>'}</div>
      </details>
      ${
        c.missingMembers.length
          ? `<details class="cand-details">
              <summary>빠지는 멤버 ${c.missingMembers.length}명</summary>
              <div class="cand-members">${missingChips}</div>
            </details>`
          : ""
      }
    `;
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
   * 9. CONTROLLER
   * ======================================================================= */

  const state = {
    payload: null,
    grid: null,
    slots: null,
    songsData: null,
    threshold: 60,
    durationMode: DEFAULTS.duration,
  };

  async function loadAndRender() {
    hideAlert();
    const loading = document.getElementById("loading");
    const errorBox = document.getElementById("error");
    loading.classList.remove("hidden");
    errorBox.classList.add("hidden");
    document.getElementById("heatmaps").innerHTML = "";
    document.getElementById("candidates").innerHTML = "";

    try {
      const payload = await fetchScheduleData();
      state.payload = payload;
      state.threshold = payload.settings.thresholdPercent;

      // 슬라이더 동기화
      const slider = document.getElementById("threshold-slider");
      const tval = document.getElementById("threshold-value");
      slider.value = state.threshold;
      tval.textContent = state.threshold;

      const { grid, slots, parseFailures } = buildHourlyGrid(payload);
      state.grid = grid;
      state.slots = slots;
      state.songsData = aggregateSongs(payload, grid, slots);

      // 자체 검증
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
      const t = payload.generatedAt ? new Date(payload.generatedAt) : new Date();
      lu.textContent = "마지막 업데이트: " + t.toLocaleString("ko-KR");

      rerender();
      // 디버그용 노출
      window.__test = {
        payload: state.payload,
        grid: state.grid,
        slots: state.slots,
        songsData: state.songsData,
        parseAvailability,
        computeSlotForRanges,
        findCandidatesForSong,
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
    renderHeatmaps(
      state.songsData,
      state.payload.dates,
      state.slots,
      state.payload.settings,
      state.threshold
    );
    renderCandidates(
      state.songsData,
      state.payload.dates,
      state.slots,
      state.payload.settings,
      state.threshold,
      state.durationMode
    );
  }

  function bindControls() {
    document.getElementById("refresh-btn").addEventListener("click", loadAndRender);

    const slider = document.getElementById("threshold-slider");
    const tval = document.getElementById("threshold-value");
    slider.addEventListener("input", (e) => {
      state.threshold = parseInt(e.target.value, 10);
      tval.textContent = state.threshold;
      rerender();
    });

    document.querySelectorAll(".duration-toggle .toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll(".duration-toggle .toggle-btn")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.durationMode = btn.dataset.duration;
        rerender();
      });
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
