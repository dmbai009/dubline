const copy = {
  en: {
    tagline:'Collaborative dubbing studio', create:'Create a room', join:'Join as a guest', hostLead:'Choose how friends will reach this computer. You can change the method later without closing the room.', start:'Start room', starting:'Starting…',
    cloudflare:'Cloudflare', cloudflareShort:'Automatic public HTTPS link. Recommended.', porthole:'Porthole', portholeShort:'Simple Steam port sharing.', vpn:'VPN', vpnShort:'Radmin VPN or Hamachi.', radmin:'Radmin VPN', radminShort:'Private virtual network.', hamachi:'Hamachi', hamachiShort:'Private virtual network.',
    automatic:'Built in', installed:'Installed', running:'Running', stopped:'Not running', missing:'Not found', checking:'Checking…',
    cloudflareTitle:'Automatic Cloudflare tunnel', cloudflareBody:'Dubline creates a secure public link automatically. This is the easiest option, but Cloudflare may be unavailable for some networks or regions.', cloudflareSteps:'No other app is required.|Wait for the invitation indicator inside the room.|If the check fails, switch to one of the alternatives.',
    portholeTitle:'Porthole through Steam', portholeBody:'A convenient fallback: both host and guests install the free Porthole app in Steam. Guests connect to localhost, so a normal browser can use the microphone.', portholeSteps:'Open Porthole and create a lobby.|When Dubline opens, enter the displayed TCP port in Porthole.|Friends join the Porthole lobby and open the localhost link you send.',
    radminTitle:'Radmin VPN', radminBody:'Everyone joins the same Radmin network. Because browsers block microphones on plain VPN addresses, guests should use Dubline.exe → Join as a guest.', radminSteps:'Create or join one Radmin VPN network.|Share the VPN room address shown inside Dubline.|Friends paste it into Dubline guest mode, then enter the room PIN.',
    hamachiTitle:'Hamachi', hamachiBody:'Everyone joins the same Hamachi network. Guests use Dubline.exe guest mode so the microphone works on the private HTTP address.', hamachiSteps:'Create or join one Hamachi network.|Share the VPN room address shown inside Dubline.|Friends paste it into Dubline guest mode, then enter the room PIN.',
    vpnTitle:'VPN through Radmin or Hamachi', vpnBody:'Choose either VPN client and have everyone join the same private network. Guests use Dubline.exe guest mode so the microphone works on the private HTTP address.', vpnSteps:'Open Radmin VPN or Hamachi and create a shared network.|When Dubline detects an active VPN address, copy the invitation from the room.|Friends open Dubline.exe → Join as a guest, paste the address, then enter the PIN.',
    open:'Open / install', 'open.radmin':'Open Radmin', 'open.hamachi':'Open Hamachi', guestTitle:'Connect to a friend', guestLead:'Paste the private address sent by the host. Dubline will restart in a restricted guest window.', address:'Room address', guestSecurity:'For safety, guest mode accepts only HTTPS, localhost, and private Radmin/Hamachi/LAN addresses. The microphone permission is granted only to that exact origin.', joinButton:'Open room', invalid:'Could not open the room: {error}', updateTitle:'A new Dubline version is ready', updateVersion:'Version {version} is available.', updateDownload:'View on GitHub', updateLater:'Later', author:'by dmbai009'
  },
  ru: {
    tagline:'Совместная студия дубляжа', create:'Создать комнату', join:'Войти гостем', hostLead:'Выберите, как друзья подключатся к этому компьютеру. Способ можно сменить позже, не закрывая комнату.', start:'Открыть комнату', starting:'Запуск…',
    cloudflare:'Cloudflare', cloudflareShort:'Автоматическая публичная HTTPS-ссылка. Рекомендуется.', porthole:'Porthole', portholeShort:'Простой проброс порта через Steam.', vpn:'VPN', vpnShort:'Radmin VPN или Hamachi.', radmin:'Radmin VPN', radminShort:'Приватная виртуальная сеть.', hamachi:'Hamachi', hamachiShort:'Приватная виртуальная сеть.',
    automatic:'Встроено', installed:'Установлено', running:'Запущено', stopped:'Не запущено', missing:'Не найдено', checking:'Проверка…',
    cloudflareTitle:'Автоматический туннель Cloudflare', cloudflareBody:'Dubline сам создаёт безопасную публичную ссылку. Это самый простой способ, но Cloudflare может быть недоступен в некоторых сетях или регионах.', cloudflareSteps:'Дополнительные программы не нужны.|Дождитесь индикатора готовности приглашения внутри комнаты.|Если проверка не пройдёт, переключитесь на один из запасных способов.',
    portholeTitle:'Porthole через Steam', portholeBody:'Удобный запасной вариант: хост и гости устанавливают бесплатный Porthole в Steam. У гостей адрес открывается через localhost, поэтому микрофон работает в обычном браузере.', portholeSteps:'Откройте Porthole и создайте лобби.|После запуска комнаты введите показанный TCP-порт в Porthole.|Друзья входят в лобби Porthole и открывают присланную localhost-ссылку.',
    radminTitle:'Radmin VPN', radminBody:'Все входят в одну сеть Radmin. Браузеры блокируют микрофон на обычном VPN-адресе, поэтому гостям нужен Dubline.exe → «Войти гостем».', radminSteps:'Создайте общую сеть Radmin VPN или войдите в неё.|Отправьте адрес комнаты, показанный внутри Dubline.|Друзья вставляют адрес в гостевой режим Dubline и вводят PIN комнаты.',
    hamachiTitle:'Hamachi', hamachiBody:'Все входят в одну сеть Hamachi. Гости используют режим Dubline.exe, чтобы микрофон работал на приватном HTTP-адресе.', hamachiSteps:'Создайте общую сеть Hamachi или войдите в неё.|Отправьте адрес комнаты, показанный внутри Dubline.|Друзья вставляют адрес в гостевой режим Dubline и вводят PIN комнаты.',
    vpnTitle:'VPN через Radmin или Hamachi', vpnBody:'Выберите любой VPN-клиент и войдите с друзьями в одну приватную сеть. Гости используют режим Dubline.exe, чтобы микрофон работал на HTTP-адресе VPN.', vpnSteps:'Откройте Radmin VPN или Hamachi и создайте общую сеть.|Когда Dubline определит активный VPN-адрес, скопируйте приглашение из комнаты.|Друзья открывают Dubline.exe → «Войти гостем», вставляют адрес и вводят PIN.',
    open:'Открыть / установить', 'open.radmin':'Открыть Radmin', 'open.hamachi':'Открыть Hamachi', guestTitle:'Подключиться к другу', guestLead:'Вставьте приватный адрес от хоста. Dubline перезапустится в ограниченном гостевом окне.', address:'Адрес комнаты', guestSecurity:'Для безопасности гостевой режим принимает только HTTPS, localhost и приватные адреса Radmin/Hamachi/LAN. Доступ к микрофону даётся только этому точному адресу.', joinButton:'Открыть комнату', invalid:'Не удалось открыть комнату: {error}', updateTitle:'Готова новая версия Dubline', updateVersion:'Доступна версия {version}.', updateDownload:'Открыть на GitHub', updateLater:'Позже', author:'автор: dmbai009'
  },
  uk: {
    tagline:'Спільна студія дубляжу', create:'Створити кімнату', join:'Увійти гостем', hostLead:'Оберіть, як друзі підключаться до цього комп’ютера. Спосіб можна змінити пізніше, не закриваючи кімнату.', start:'Відкрити кімнату', starting:'Запуск…',
    cloudflare:'Cloudflare', cloudflareShort:'Автоматичне публічне HTTPS-посилання. Рекомендовано.', porthole:'Porthole', portholeShort:'Просте перенаправлення порту через Steam.', vpn:'VPN', vpnShort:'Radmin VPN або Hamachi.', radmin:'Radmin VPN', radminShort:'Приватна віртуальна мережа.', hamachi:'Hamachi', hamachiShort:'Приватна віртуальна мережа.',
    automatic:'Вбудовано', installed:'Встановлено', running:'Запущено', stopped:'Не запущено', missing:'Не знайдено', checking:'Перевірка…',
    cloudflareTitle:'Автоматичний тунель Cloudflare', cloudflareBody:'Dubline сам створює безпечне публічне посилання. Це найпростіший спосіб, але Cloudflare може бути недоступний у деяких мережах або регіонах.', cloudflareSteps:'Додаткові програми не потрібні.|Дочекайтеся індикатора готовності запрошення у кімнаті.|Якщо перевірка не пройде, перемкніться на один із запасних способів.',
    portholeTitle:'Porthole через Steam', portholeBody:'Зручний запасний варіант: хост і гості встановлюють безкоштовний Porthole у Steam. У гостей адреса відкривається через localhost, тому мікрофон працює у звичайному браузері.', portholeSteps:'Відкрийте Porthole і створіть лобі.|Після запуску кімнати введіть показаний TCP-порт у Porthole.|Друзі входять у лобі Porthole та відкривають надіслане localhost-посилання.',
    radminTitle:'Radmin VPN', radminBody:'Усі входять в одну мережу Radmin. Браузери блокують мікрофон на звичайній VPN-адресі, тому гостям потрібен Dubline.exe → «Увійти гостем».', radminSteps:'Створіть спільну мережу Radmin VPN або приєднайтесь до неї.|Надішліть адресу кімнати, показану в Dubline.|Друзі вставляють адресу в гостьовий режим Dubline і вводять PIN кімнати.',
    hamachiTitle:'Hamachi', hamachiBody:'Усі входять в одну мережу Hamachi. Гості використовують режим Dubline.exe, щоб мікрофон працював на приватній HTTP-адресі.', hamachiSteps:'Створіть спільну мережу Hamachi або приєднайтесь до неї.|Надішліть адресу кімнати, показану в Dubline.|Друзі вставляють адресу в гостьовий режим Dubline і вводять PIN кімнати.',
    vpnTitle:'VPN через Radmin або Hamachi', vpnBody:'Оберіть будь-який VPN-клієнт і увійдіть із друзями в одну приватну мережу. Гості використовують режим Dubline.exe, щоб мікрофон працював на HTTP-адресі VPN.', vpnSteps:'Відкрийте Radmin VPN або Hamachi та створіть спільну мережу.|Коли Dubline визначить активну VPN-адресу, скопіюйте запрошення з кімнати.|Друзі відкривають Dubline.exe → «Увійти гостем», вставляють адресу та вводять PIN.',
    open:'Відкрити / встановити', 'open.radmin':'Відкрити Radmin', 'open.hamachi':'Відкрити Hamachi', guestTitle:'Підключитися до друга', guestLead:'Вставте приватну адресу від хоста. Dubline перезапуститься в обмеженому гостьовому вікні.', address:'Адреса кімнати', guestSecurity:'Для безпеки гостьовий режим приймає лише HTTPS, localhost і приватні адреси Radmin/Hamachi/LAN. Доступ до мікрофона надається лише цій точній адресі.', joinButton:'Відкрити кімнату', invalid:'Не вдалося відкрити кімнату: {error}', updateTitle:'Готова нова версія Dubline', updateVersion:'Доступна версія {version}.', updateDownload:'Відкрити на GitHub', updateLater:'Пізніше', author:'автор: dmbai009'
  }
};

const modes = ['cloudflare', 'porthole', 'vpn'];
let language = (window.dublineLauncher.language || localStorage.getItem('dubline_language') || 'en').slice(0, 2);
if (!copy[language]) language = 'en';
localStorage.setItem('dubline_language', language);
window.dublineLauncher.setLanguage?.(language).catch(() => {});
let selectedMode = 'cloudflare';
let tools = null;
let updateStatus = null;
let updateDismissed = false;
const tr = (key, params = {}) => (copy[language][key] || copy.en[key] || key).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '');

function toolBadge(mode) {
  if (mode === 'cloudflare') return { text:tr('automatic'), css:'good' };
  if (!tools) return { text:tr('checking'), css:'' };
  const tool = mode === 'vpn' ? {
    installed: tools.radmin?.installed || tools.hamachi?.installed,
    running: tools.radmin?.running || tools.hamachi?.running
  } : tools[mode] || {};
  if (tool.running) return { text:tr('running'), css:'good' };
  if (tool.installed) return { text:tr('stopped'), css:'' };
  return { text:tr('missing'), css:'bad' };
}

function render() {
  document.documentElement.lang = language;
  document.getElementById('language').value = language;
  document.querySelectorAll('[data-t]').forEach(node => { node.textContent = tr(node.dataset.t); });
  const modesNode = document.getElementById('modes');
  modesNode.replaceChildren(...modes.map(mode => {
    const button = document.createElement('button');
    button.className = `mode${selectedMode === mode ? ' active' : ''}`;
    button.dataset.mode = mode;
    const badge = toolBadge(mode);
    button.innerHTML = `<strong></strong><small></small><span class="badge ${badge.css}"></span>`;
    button.querySelector('strong').textContent = tr(mode);
    button.querySelector('small').textContent = tr(`${mode}Short`);
    button.querySelector('.badge').textContent = badge.text;
    button.addEventListener('click', () => { selectedMode = mode; render(); });
    return button;
  }));
  const details = document.getElementById('modeDetails');
  details.replaceChildren();
  const title = document.createElement('h2'); title.textContent = tr(`${selectedMode}Title`);
  const body = document.createElement('p'); body.textContent = tr(`${selectedMode}Body`);
  const steps = document.createElement('ol');
  tr(`${selectedMode}Steps`).split('|').forEach(value => { const li=document.createElement('li'); li.textContent=value; steps.append(li); });
  details.append(title, body, steps);
  if (selectedMode !== 'cloudflare') {
    const toolNames = selectedMode === 'vpn' ? ['radmin', 'hamachi'] : [selectedMode];
    toolNames.forEach(tool => {
      const open = document.createElement('button'); open.className='tool-action';
      open.textContent = selectedMode === 'vpn' ? tr(`open.${tool}`) : tr('open');
      open.addEventListener('click', () => window.dublineLauncher.openNetworkTool(tool));
      details.append(open);
    });
  }
  renderUpdate();
}

function renderUpdate() {
  const banner = document.getElementById('updateBanner');
  if (updateStatus?.currentVersion) document.getElementById('launcherVersion').textContent = `Dubline v${updateStatus.currentVersion}`;
  const available = !updateDismissed && !updateStatus?.dismissed && updateStatus?.state === 'available';
  banner.classList.toggle('show', available);
  if (!available) return;
  document.getElementById('updateTitle').textContent = tr('updateTitle');
  document.getElementById('updateVersion').textContent = tr('updateVersion', { version:updateStatus.version });
  document.getElementById('updateDownload').textContent = tr('updateDownload');
  document.getElementById('updateLater').textContent = tr('updateLater');
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('active', item === button));
  document.getElementById('hostScreen').classList.toggle('active', button.dataset.view === 'host');
  document.getElementById('guestScreen').classList.toggle('active', button.dataset.view === 'guest');
}));
document.getElementById('language').addEventListener('change', event => { language=event.target.value; localStorage.setItem('dubline_language',language); window.dublineLauncher.setLanguage?.(language).catch(() => {}); render(); });
document.getElementById('startHost').addEventListener('click', async event => {
  event.currentTarget.disabled=true; event.currentTarget.textContent=tr('starting'); document.getElementById('hostError').textContent='';
  try { const result=await window.dublineLauncher.startHost(selectedMode); if (!result.ok) throw new Error(result.error); }
  catch (err) { document.getElementById('hostError').textContent=tr('invalid',{error:err.message}); event.currentTarget.disabled=false; event.currentTarget.textContent=tr('start'); }
});
document.getElementById('joinGuest').addEventListener('click', async event => {
  event.currentTarget.disabled=true; document.getElementById('guestError').textContent='';
  try { const result=await window.dublineLauncher.joinGuest(document.getElementById('guestAddress').value); if (!result.ok) throw new Error(result.error); }
  catch (err) { document.getElementById('guestError').textContent=tr('invalid',{error:err.message}); event.currentTarget.disabled=false; }
});
document.getElementById('guestAddress').addEventListener('keydown', event => { if (event.key === 'Enter') document.getElementById('joinGuest').click(); });
document.getElementById('updateDownload').addEventListener('click', () => window.dublineLauncher.openUpdate());
document.getElementById('projectLink').addEventListener('click', () => window.dublineLauncher.openProject());
const dismissUpdate = () => { updateDismissed=true; renderUpdate(); window.dublineLauncher.dismissUpdate?.(); };
document.getElementById('updateLater').addEventListener('click', dismissUpdate);
document.getElementById('updateClose').addEventListener('click', dismissUpdate);

async function refreshTools() { try { tools=await window.dublineLauncher.detectTools(); render(); } catch (_) {} }
async function initUpdate() {
  if (typeof window.dublineLauncher.getUpdateStatus !== 'function') return;
  try { updateStatus=await window.dublineLauncher.getUpdateStatus(); renderUpdate(); } catch (_) {}
  window.dublineLauncher.onUpdateStatus?.(status => { updateStatus=status; renderUpdate(); });
}
render(); refreshTools(); initUpdate(); setInterval(refreshTools, 4000);
