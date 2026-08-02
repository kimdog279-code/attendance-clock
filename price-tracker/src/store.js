'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

/** 수집 결과를 JSONL 로 누적한다(가격 추이 비교용 원본). */
function appendJsonl(result, file = path.join(DATA_DIR, 'prices.jsonl')) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const base = {
    collectedAt: result.collectedAt,
    keyword: result.query.keyword,
    target: result.query.target || null,
    checkin: result.query.checkin,
    checkout: result.query.checkout,
    adults: result.query.adults,
    children: result.query.children,
  };
  const targetName = result.target ? result.target.name : null;

  const rows = [
    ...result.items.map((item) => ({
      ...base,
      kind: 'listing',
      isTarget: Boolean(targetName && item.name === targetName),
      name: item.name,
      priceMin: item.priceMin,
      priceMax: item.priceMax,
      prices: item.prices,
      url: item.url || null,
      source: item.source,
    })),
    ...(result.rooms || []).map((room) => ({
      ...base,
      kind: 'room',
      isTarget: true,
      hotel: targetName,
      name: room.name,
      stayType: room.stayType || null,
      priceMin: room.priceMin,
      priceMax: room.priceMax,
      prices: room.prices,
      url: result.detailUrl || null,
      source: room.source,
    })),
  ];

  if (rows.length) fs.appendFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** 엑셀에서 바로 열 수 있게 CSV 로도 남긴다(BOM 포함). */
function writeCsv(result, file) {
  const label = (result.query.target || result.query.keyword).replace(/[\\/:*?"<>|]/g, '');
  const stamp = result.collectedAt.slice(0, 19).replace(/[:T-]/g, '');
  const target = file || path.join(DATA_DIR, `${label}_${result.query.checkin}_${stamp}.csv`);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const people = `성인${result.query.adults}${result.query.children ? ` 아동${result.query.children}` : ''}`;
  const targetName = result.target ? result.target.name : null;

  const header = [
    '수집시각',
    '검색어',
    '구분',
    '목표숙소',
    '체크인',
    '체크아웃',
    '인원',
    '숙소명',
    '객실구분',
    '최저가',
    '최고가',
    '수집된가격들',
    '링크',
  ];
  const rows = [
    ...result.items.map((item) => [
      result.collectedAt,
      result.query.keyword,
      '검색목록',
      targetName && item.name === targetName ? 'O' : '',
      result.query.checkin,
      result.query.checkout,
      people,
      item.name,
      '',
      item.priceMin,
      item.priceMax,
      item.prices.join(' / '),
      item.url || '',
    ]),
    ...(result.rooms || []).map((room) => [
      result.collectedAt,
      result.query.keyword,
      '객실',
      'O',
      result.query.checkin,
      result.query.checkout,
      people,
      `${targetName || ''} — ${room.name}`,
      room.stayType || '',
      room.priceMin,
      room.priceMax,
      room.prices.join(' / '),
      result.detailUrl || '',
    ]),
  ].map((cells) => cells.map(csvCell).join(','));

  fs.writeFileSync(target, `﻿${[header.map(csvCell).join(','), ...rows].join('\n')}\n`, 'utf8');
  return target;
}

module.exports = { appendJsonl, writeCsv, DATA_DIR };
