#!/usr/bin/env node
'use strict';

const { collect } = require('./yanolja');
const { appendJsonl, writeCsv } = require('./store');

const DEFAULTS = {
  keyword: '속초해수욕장',
  target: '속초굿모닝호텔',
  checkin: '2026-08-02',
  nights: 1,
  adults: 2,
  children: 0,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS, rooms: true, headless: true, debug: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--keyword':
      case '-k':
        opts.keyword = next();
        break;
      case '--target':
      case '-t':
        opts.target = next();
        break;
      case '--all':
        opts.target = null; // 특정 호텔로 좁히지 않고 전체 목록만 수집
        break;
      case '--no-rooms':
        opts.rooms = false;
        break;
      case '--checkin':
      case '-d':
        opts.checkin = next();
        break;
      case '--nights':
      case '-n':
        opts.nights = Number(next());
        break;
      case '--adults':
      case '-a':
        opts.adults = Number(next());
        break;
      case '--children':
      case '-c':
        opts.children = Number(next());
        break;
      case '--show':
        opts.headless = false; // 브라우저 창을 띄워서 눈으로 확인
        break;
      case '--debug':
        opts.debug = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`알 수 없는 옵션: ${arg}`);
    }
  }
  return opts;
}

const USAGE = `
야놀자 가격 수집기

  node src/cli.js [옵션]

옵션
  -k, --keyword <검색어>    기본값: ${DEFAULTS.keyword}
  -t, --target <숙소명>      결과 중 이 숙소를 찾아 객실 가격까지 수집. 기본값: ${DEFAULTS.target}
      --all                  목표 숙소 없이 전체 목록만 수집
      --no-rooms             목표 숙소를 찾아도 상세(객실) 페이지는 열지 않는다
  -d, --checkin <YYYY-MM-DD> 체크인 날짜. 기본값: ${DEFAULTS.checkin}
  -n, --nights <숫자>        숙박 일수. 기본값: ${DEFAULTS.nights}
  -a, --adults <숫자>        성인 인원. 기본값: ${DEFAULTS.adults}
  -c, --children <숫자>      아동 인원. 기본값: ${DEFAULTS.children}
      --show                 브라우저 창을 띄워서 진행 과정을 본다
      --debug                스크린샷·HTML 을 debug/ 에 저장한다
  -h, --help                 이 도움말

예시
  node src/cli.js --keyword 속초해수욕장 --target 속초굿모닝호텔 --checkin 2026-08-02 --adults 2 --show --debug
`;

function formatWon(n) {
  return `${n.toLocaleString('ko-KR')}원`;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  console.log(
    `검색 조건 → "${opts.keyword}" / ${opts.checkin} 부터 ${opts.nights}박 / 성인 ${opts.adults}명` +
      (opts.children ? ` · 아동 ${opts.children}명` : ''),
  );
  if (opts.target) console.log(`목표 숙소 → ${opts.target}`);

  const result = await collect(opts);

  if (!result.items.length) {
    console.error('\n수집된 가격이 없습니다.');
    console.error('debug/ 폴더의 스크린샷과 HTML 을 확인하세요. 다음이 흔한 원인입니다:');
    console.error('  · 봇 차단 페이지 → --show 로 창을 띄워 직접 통과한 뒤 재시도');
    console.error('  · 검색 결과 0건 → 검색어를 "속초" 처럼 넓게 바꿔보기');
    console.error('  · 마크업 변경 → src/extract.js 의 셀렉터·키 목록 갱신 필요');
    process.exitCode = 1;
    return;
  }

  console.log(`\n수집 완료: ${result.items.length}건  (${result.url})`);

  if (opts.target) {
    console.log(`\n${'='.repeat(60)}`);
    if (result.target) {
      const t = result.target;
      const price =
        t.priceMin === t.priceMax ? formatWon(t.priceMin) : `${formatWon(t.priceMin)} ~ ${formatWon(t.priceMax)}`;
      console.log(`■ ${t.name}  (일치도 ${t.matchScore}%)`);
      console.log(`  검색 목록 가격: ${price}`);
      if (result.detailUrl) console.log(`  상세: ${result.detailUrl}`);

      if (result.rooms.length) {
        console.log(`\n  객실별 가격 (${result.rooms.length}건)`);
        const width = Math.min(34, Math.max(...result.rooms.map((r) => r.name.length)));
        for (const room of result.rooms) {
          const name = room.name.length > width ? `${room.name.slice(0, width - 1)}…` : room.name.padEnd(width);
          const rp =
            room.priceMin === room.priceMax
              ? formatWon(room.priceMin)
              : `${formatWon(room.priceMin)} ~ ${formatWon(room.priceMax)}`;
          console.log(`    ${name}  ${room.stayType ? `[${room.stayType}] ` : ''}${rp}`);
        }
      } else if (opts.rooms) {
        console.log('\n  객실별 가격은 수집하지 못했습니다(상세 페이지 구조 변경 또는 매진).');
      }
    } else {
      console.log(`■ "${opts.target}" 를 찾지 못했습니다.`);
      if (result.targetCandidates.length) {
        console.log('  이름이 비슷한 후보:');
        for (const c of result.targetCandidates) {
          console.log(`    ${c.name}  ${formatWon(c.priceMin)}  (일치도 ${c.score}%)`);
        }
        console.log('  맞는 이름이 있으면 --target 에 그대로 넣어 다시 실행하세요.');
      } else {
        console.log('  해당 날짜에 매진이거나 야놀자에 등록되지 않았을 수 있습니다.');
      }
    }
    console.log('='.repeat(60));
  }

  console.log('\n[검색 결과 전체]');
  const top = result.items.slice(0, 30);
  const width = Math.min(40, Math.max(...top.map((i) => i.name.length)));
  for (const [idx, item] of top.entries()) {
    const name = item.name.length > width ? `${item.name.slice(0, width - 1)}…` : item.name.padEnd(width);
    const price =
      item.priceMin === item.priceMax
        ? formatWon(item.priceMin)
        : `${formatWon(item.priceMin)} ~ ${formatWon(item.priceMax)}`;
    console.log(`${String(idx + 1).padStart(3)}. ${name}  ${price}`);
  }
  if (result.items.length > top.length) console.log(`   ... 외 ${result.items.length - top.length}건`);

  const jsonl = appendJsonl(result);
  const csv = writeCsv(result);
  console.log(`\n저장: ${jsonl}`);
  console.log(`저장: ${csv}`);
  console.log('\n※ 화면에 보이는 가격은 1박 기준·할인 전/후가 섞여 있을 수 있습니다. 최저가/최고가를 함께 기록했습니다.');
}

main().catch((err) => {
  console.error(`\n실패: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
