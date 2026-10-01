// 트립N빵(구 엔빵) 웹 베타 설정.
// 비워 두면 "로컬 모드"(이 기기에만 저장, 공유 링크 = 현재 상태 스냅샷)로 동작한다.
// Supabase 프로젝트를 만들고 supabase/schema.sql 을 실행한 뒤 아래 두 값을 넣으면
// "클라우드 모드"(링크로 여럿이 실시간 입력 + 베타 지표 집계)로 바뀐다.
// anon key는 공개용 키라 웹에 노출돼도 된다 — 권한은 RPC 함수가 통제한다.
window.ENBBANG_CONFIG = {
  supabaseUrl: 'https://nkmkqczahmwqjddzpeqr.supabase.co',
  supabaseAnonKey: 'sb_publishable_EkAloSEEewcCT4qyu6smSQ_gk4kDT_R',
};
