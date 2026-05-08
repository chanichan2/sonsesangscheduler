/**
 * 봄축제 일정조사 — Apps Script
 *
 * 기능:
 *   1) 일정조사 시트의 셀이 수정되면 즉시 형식 검증 (빨간 배경 + 안내 메모)
 *   2) 메뉴: 분석 기간을 바탕으로 일정조사 시트의 날짜 헤더 자동 생성
 *   3) 메뉴: 전체 시트 형식 재검증
 *   4) 웹앱 GET/POST: 시트 데이터 + 팀연습 예약 영속화
 *
 * 설치 방법:
 *   1) Google Spreadsheet 열기
 *   2) 확장 프로그램 → Apps Script
 *   3) 기본 코드 모두 삭제 후 이 파일 내용 전체 복사 붙여넣기
 *   4) 저장 (Ctrl+S 또는 ⌘+S) → 권한 승인
 *   5) 스프레드시트 새로고침
 *   6) 상단 메뉴에 "📅 일정조사 도구"가 생긴 것 확인
 *   7) 배포(Deploy) → 배포 관리(Manage deployments) → 기존 배포 편집 → 새 버전(New version) 선택 → 배포
 *
 * 이 파일은 Apps Script의 백업본. Apps Script 쪽을 수정하면 이쪽도 같이 갱신해 두면 좋음.
 */


// ─────────────────────────────────────────────
// 1. 검증 로직 (입력 형식 정규식)
// ─────────────────────────────────────────────

const ALLOWED_PATTERNS = [
  /^O$/,
  /^X$/,
  /^미정$/,
  /^X\(미정\)$/,
];

/**
 * 한글 입력기가 자동으로 바꾸곤 하는 유사/전각 문자를 클라이언트와 동일하게 정규화.
 * (클라이언트 `normalizeRaw`와 동일 동작 — 시트 검증과 클라 파싱이 어긋나지 않게.)
 */
function normalizeRaw_(raw) {
  let s = String(raw);
  // 제로폭/BOM 제거 (U+200B..U+200D, U+FEFF)
  s = s.replace(/[​-‍﻿]/g, "");
  // 각종 대시/하이픈/장음 부호 → '-'
  s = s.replace(/[‐-―−﹘﹣－]/g, "-");
  // 각종 물결/웨이브 → '~'
  s = s.replace(/[∼〜〰～]/g, "~");
  // 전각 괄호 → 반각
  s = s.replace(/（/g, "(").replace(/）/g, ")");
  // 전각 콜론 → ':'
  s = s.replace(/：/g, ":");
  // 전각/한자 쉼표 → ','
  s = s.replace(/[，、]/g, ",");
  // 전각 숫자 → 반각
  s = s.replace(/[０-９]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30);
  });
  // 전각 영문 O/X
  s = s.replace(/[Ｏｏ]/g, "O").replace(/[Ｘｘ]/g, "X");
  return s;
}

/**
 * 시간 범위 세그먼트 검증
 * 허용:
 *   - 13~17, 13:30~17, 16~17:30, 13:30~17:30 (양쪽 비대칭 OK)
 *   - 13~  (시작 시각만)
 *   - ~15  (종료 시각만)
 *   - 하이픈(-) 또는 물결(~) 둘 다 허용
 */
function isValidTimeRange(seg) {
  const m1 = seg.match(/^(\d{1,2}(?::\d{2})?)[~\-](\d{1,2}(?::\d{2})?)$/);
  if (m1) return validHM(m1[1]) && validHM(m1[2]);

  const m2 = seg.match(/^(\d{1,2}(?::\d{2})?)[~\-]$/);
  if (m2) return validHM(m2[1]);

  const m3 = seg.match(/^[~\-](\d{1,2}(?::\d{2})?)$/);
  if (m3) return validHM(m3[1]);

  return false;
}

function validHM(s) {
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return false;
  const h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (h < 0 || h > 24) return false;
  if (min < 0 || min >= 60) return false;
  // 24시는 자정(다음날 0시)을 가리키는 경계값으로만 허용. 24:30 같은 표기는 의미가 없음.
  if (h === 24 && min !== 0) return false;
  return true;
}

/**
 * 셀 입력값 검증 + 자동 정규화
 * @param {*} rawValue 원본 셀 값
 * @return {{valid: boolean, normalized: string}}
 */
function validateAvailability(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return { valid: true, normalized: "" };
  }

  // 1) 전각/유사 문자 정규화 (클라이언트와 동일하게)
  let s = normalizeRaw_(rawValue);

  // 2) 모든 공백 제거
  s = s.replace(/\s+/g, "");

  // 3) 알파벳 o, x를 대문자로 변환 (한글 등 다른 문자는 영향 없음)
  s = s.replace(/o/g, "O").replace(/x/g, "X");

  // 4) 단순 패턴 (O, X, 미정, X(미정))
  for (const p of ALLOWED_PATTERNS) {
    if (p.test(s)) return { valid: true, normalized: s };
  }

  // 5) (미정) 접미만 허용. 앞쪽 (미정) 표기는 불가
  let body = s;
  const sufMatch = s.match(/^(.+)\(미정\)$/);
  if (sufMatch) {
    body = sufMatch[1];
  }

  if (body.length === 0) {
    return { valid: false, normalized: s };
  }

  // 6) 콤마로 분리된 시간 범위 검증
  const segs = body.split(",");
  for (const seg of segs) {
    if (!isValidTimeRange(seg)) {
      return { valid: false, normalized: s };
    }
  }

  return { valid: true, normalized: s };
}


// ─────────────────────────────────────────────
// 2. onEdit 트리거 — 셀 수정 시 즉시 검증
// ─────────────────────────────────────────────

function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== "일정조사") return;

  const range = e.range;
  const row = range.getRow();
  const col = range.getColumn();

  // 1행(날짜 헤더), 1열(부원명)은 제외
  if (row < 2 || col < 2) return;

  // 다중 셀 수정(붙여넣기 등)도 처리
  const numRows = range.getNumRows();
  const numCols = range.getNumColumns();

  for (let i = 0; i < numRows; i++) {
    for (let j = 0; j < numCols; j++) {
      const cell = range.getCell(i + 1, j + 1);
      const value = cell.getValue();
      const result = validateAvailability(value);

      if (result.valid) {
        cell.setBackground(null);
        cell.clearNote();
        if (value !== "" && result.normalized !== String(value)) {
          cell.setValue(result.normalized);  // 공백 제거, 대소문자 정리, 전각 → 반각
        }
      } else {
        cell.setBackground("#F8C9C9");  // 흐린 빨강
        cell.setNote(
          "❌ 입력 형식이 올바르지 않습니다.\n" +
          "규격안내 시트를 참고해주세요.\n\n" +
          "예시:\n" +
          "  O, X, 미정, X(미정)\n" +
          "  13~, ~15, 13:30~17:30\n" +
          "  9~12,18~\n" +
          "  13~17(미정)"
        );
      }
    }
  }
}


// ─────────────────────────────────────────────
// 3. 메뉴 — 도구 제공
// ─────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("📅 일정조사 도구")
    .addItem("날짜 헤더 자동 생성", "regenerateDateHeaders")
    .addItem("전체 시트 형식 재검증", "revalidateAllCells")
    .addToUi();
}

/**
 * 설정 시트의 분석 기간을 읽어서 일정조사 시트의 1행에 날짜 헤더를 자동 생성한다.
 * 부원 명단(A열)은 건드리지 않는다.
 */
function regenerateDateHeaders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const settings = ss.getSheetByName("설정");
  const sheet = ss.getSheetByName("일정조사");

  if (!settings || !sheet) {
    SpreadsheetApp.getUi().alert("'설정' 또는 '일정조사' 시트를 찾을 수 없습니다.");
    return;
  }

  const startDate = settings.getRange("B3").getValue();
  const endDate = settings.getRange("B4").getValue();

  if (!(startDate instanceof Date) || !(endDate instanceof Date)) {
    SpreadsheetApp.getUi().alert(
      "'설정' 시트의 B3(분석 시작일), B4(분석 종료일)에 날짜를 입력하세요."
    );
    return;
  }

  if (startDate > endDate) {
    SpreadsheetApp.getUi().alert("분석 시작일이 종료일보다 늦습니다.");
    return;
  }

  // 날짜 목록 생성
  const dates = [];
  const cur = new Date(startDate);
  while (cur <= endDate) {
    dates.push(`${cur.getMonth() + 1}/${cur.getDate()}`);
    cur.setDate(cur.getDate() + 1);
  }

  // 기존 1행 (B1부터 끝까지) 비우기
  const lastCol = Math.max(sheet.getLastColumn(), dates.length + 1);
  if (lastCol >= 2) {
    sheet.getRange(1, 2, 1, lastCol - 1).clearContent().clearFormat();
  }

  // 새 날짜 입력
  sheet.getRange(1, 2, 1, dates.length).setValues([dates]);

  // 헤더 서식
  const headerRange = sheet.getRange(1, 2, 1, dates.length);
  headerRange.setBackground("#F4CCCC");
  headerRange.setFontWeight("bold");
  headerRange.setHorizontalAlignment("center");
  headerRange.setBorder(true, true, true, true, true, true, "#CCCCCC", SpreadsheetApp.BorderStyle.SOLID);

  // 열 폭
  for (let i = 2; i < 2 + dates.length; i++) {
    sheet.setColumnWidth(i, 80);
  }

  SpreadsheetApp.getUi().alert(
    `날짜 ${dates.length}개를 생성했습니다.\n` +
    `${dates[0]} ~ ${dates[dates.length - 1]}`
  );
}

/**
 * 일정조사 시트의 모든 입력 셀에 대해 검증을 다시 실행
 */
function revalidateAllCells() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("일정조사");
  if (!sheet) {
    SpreadsheetApp.getUi().alert("'일정조사' 시트를 찾을 수 없습니다.");
    return;
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 2) {
    SpreadsheetApp.getUi().alert("검증할 데이터가 없습니다.");
    return;
  }

  const range = sheet.getRange(2, 2, lastRow - 1, lastCol - 1);
  const values = range.getValues();
  const backgrounds = [];
  const notes = [];
  const normalizedValues = [];
  let invalidCount = 0;
  let normalizedCount = 0;

  for (let i = 0; i < values.length; i++) {
    const bgRow = [];
    const noteRow = [];
    const valRow = [];
    for (let j = 0; j < values[i].length; j++) {
      const orig = values[i][j];
      const result = validateAvailability(orig);
      if (result.valid) {
        bgRow.push(null);
        noteRow.push("");
        if (orig !== "" && orig !== null && result.normalized !== String(orig)) {
          valRow.push(result.normalized);
          normalizedCount++;
        } else {
          valRow.push(orig);
        }
      } else {
        bgRow.push("#F8C9C9");
        noteRow.push(
          "❌ 입력 형식이 올바르지 않습니다.\n" +
          "규격안내 시트를 참고해주세요."
        );
        valRow.push(orig);
        invalidCount++;
      }
    }
    backgrounds.push(bgRow);
    notes.push(noteRow);
    normalizedValues.push(valRow);
  }

  range.setBackgrounds(backgrounds);
  range.setNotes(notes);
  range.setValues(normalizedValues);

  SpreadsheetApp.getUi().alert(
    `검증 완료\n\n` +
    `오류 셀: ${invalidCount}개\n` +
    `자동 정리된 셀: ${normalizedCount}개`
  );
}

// ─────────────────────────────────────────────
// 4. 웹앱 API — 외부 웹사이트가 데이터를 가져갈 수 있게
// ─────────────────────────────────────────────

function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // 설정 시트 읽기
    const settingSheet = ss.getSheetByName("설정");
    const settings = {
      startDate: settingSheet.getRange("B3").getValue(),
      endDate: settingSheet.getRange("B4").getValue(),
      thresholdPercent: settingSheet.getRange("B5").getValue(),
      startHour: settingSheet.getRange("B6").getValue(),
      endHour: settingSheet.getRange("B7").getValue(),
    };
    if (settings.startDate instanceof Date) {
      settings.startDate = Utilities.formatDate(settings.startDate, "GMT+9", "yyyy-MM-dd");
    }
    if (settings.endDate instanceof Date) {
      settings.endDate = Utilities.formatDate(settings.endDate, "GMT+9", "yyyy-MM-dd");
    }

    // 곡정보 시트 읽기
    const songSheet = ss.getSheetByName("곡정보");
    const songData = songSheet.getDataRange().getValues();
    const songs = [];
    for (let i = 3; i < songData.length; i++) {
      const row = songData[i];
      if (!row[0]) continue;
      const members = [];
      for (let j = 2; j < row.length; j++) {
        if (row[j] && String(row[j]).trim()) {
          members.push(String(row[j]).trim());
        }
      }
      songs.push({
        name: String(row[0]).trim(),
        capacity: parseInt(row[1], 10) || members.length,
        members: members,
      });
    }

    // 일정조사 시트 읽기
    const schedSheet = ss.getSheetByName("일정조사");
    const schedData = schedSheet.getDataRange().getValues();
    const dateHeaders = [];
    if (schedData.length > 0) {
      for (let j = 1; j < schedData[0].length; j++) {
        const h = schedData[0][j];
        if (h !== "" && h !== null) dateHeaders.push(String(h).trim());
      }
    }
    const availability = {};
    for (let i = 1; i < schedData.length; i++) {
      const name = schedData[i][0];
      if (!name) continue;
      const memberName = String(name).trim();
      availability[memberName] = {};
      for (let j = 1; j <= dateHeaders.length; j++) {
        const cellVal = schedData[i][j];
        availability[memberName][dateHeaders[j - 1]] =
          cellVal === null || cellVal === undefined ? "" : String(cellVal).trim();
      }
    }

    const payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      settings: settings,
      dates: dateHeaders,
      songs: songs,
      availability: availability,
      bookings: getBookings_(),
    };

    return ContentService.createTextOutput(JSON.stringify(payload))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: String(err),
    })).setMimeType(ContentService.MimeType.JSON);
  }
}


/* ======================================================================
 * 예약(팀 연습 일정) 영속화
 * ====================================================================== */

const BOOKINGS_PROP_KEY = 'bookings_v1';

function getBookings_() {
  const raw = PropertiesService.getScriptProperties().getProperty(BOOKINGS_PROP_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function setBookings_(arr) {
  PropertiesService.getScriptProperties()
    .setProperty(BOOKINGS_PROP_KEY, JSON.stringify(arr));
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * doPost — 팀연습 예약 추가/취소/전체초기화/조회.
 *
 * 동시성 보호: PropertiesService는 read-modify-write가 원자적이지 않아서, 두 사용자가
 * 거의 같은 시간에 다른 셀을 클릭하면 한쪽 변경이 사라질 수 있다. ScriptLock으로 직렬화.
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  let acquired = false;
  try {
    // 최대 5초까지 락 대기. 실패 시 throw → 아래 catch에서 에러 응답.
    lock.waitLock(5000);
    acquired = true;

    const body = JSON.parse(e.postData.contents);
    let bookings = getBookings_();
    if (body.action === 'add') {
      if (!bookings.includes(body.key)) bookings.push(body.key);
      setBookings_(bookings);
    } else if (body.action === 'remove') {
      bookings = bookings.filter(function (k) { return k !== body.key; });
      setBookings_(bookings);
    } else if (body.action === 'clear') {
      bookings = [];
      setBookings_(bookings);
    } else if (body.action !== 'list') {
      return jsonOut_({ ok: false, error: 'unknown action: ' + body.action });
    }
    return jsonOut_({ ok: true, bookings: bookings });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message || err) });
  } finally {
    if (acquired) lock.releaseLock();
  }
}
