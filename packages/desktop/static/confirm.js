// 확인 창 렌더러. 모든 글은 textContent 로만 넣는다(메인에서 이미 정화됨). 버튼은 enableDelayMs 뒤에 활성화된다.
const byId = (id) => document.getElementById(id);

window.aeyesConfirm.onShow((view) => {
  document.title = view.title;
  byId('account').textContent = view.account;
  byId('origin').textContent = `(${view.origin})`;
  byId('tool').textContent = view.tool;
  byId('summary').textContent = view.summary;

  const box = byId('buttons');
  box.replaceChildren();
  const buttons = view.buttons.map((spec) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = spec.label;
    el.className = spec.id === 'deny' ? 'deny' : 'allow';
    el.disabled = true;
    el.addEventListener('click', () => {
      for (const b of buttons) b.disabled = true;
      window.aeyesConfirm.decide(view.id, spec.id);
    });
    box.appendChild(el);
    return el;
  });
  setTimeout(() => { for (const b of buttons) b.disabled = false; }, view.enableDelayMs);

  let left = view.timeoutSec;
  const countdown = byId('countdown');
  countdown.textContent = `${left}초 뒤 자동으로 거부됩니다`;
  const timer = setInterval(() => {
    left -= 1;
    countdown.textContent = `${Math.max(left, 0)}초 뒤 자동으로 거부됩니다`;
    if (left <= 0) clearInterval(timer);
  }, 1000);
});
