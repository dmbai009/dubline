(() => {
  const messages = {
    en: {
      'app.title': 'Dubline — Collaborative dubbing studio', 'app.subtitle': 'Collaborative dubbing studio',
      'room': 'Room:', 'share': '🔗 Share', 'share.title': 'Copy invitation link',
      'online': '👥 Online:', 'files': '📁 Files & Export', 'settings': '⚙️ Settings', 'chat': '💬 Chat',
      'welcome': '🎙️ Welcome to Dubline', 'welcome.help': 'Choose a nickname so your friends can see who claimed each role:',
      'nickname.placeholder': 'Your nickname…', 'enterStudio': 'Enter studio',
      'settings.title': '⚙️ Studio settings', 'close': 'Close', 'userTab': '👤 User', 'playerTab': '🎛️ Player & Room',
      'nickname': 'Nickname in this room', 'nickname.help': 'Shown on your lines and in chat', 'save': 'Save',
      'micGain': 'Microphone gain', 'micGain.help': 'Boost quiet headsets and microphones',
      'noiseSuppression': 'Browser noise & echo suppression', 'noiseSuppression.help': 'Built-in WebRTC microphone processing',
      'language': 'Language', 'language.help': 'Interface language on this device',
      'autoDuck': 'Auto-ducking', 'autoDuck.help': 'Lowers background and original audio while takes are playing',
      'duckAmount': 'Background reduction:', 'prompter': 'Video prompter', 'prompter.help': 'Shows the current line and character over the video',
      'prompterSize': 'Subtitle font size:', 'files.title': '📁 Files & Export', 'importTab': '⬆ Import',
      'libraryTab': '📂 Server packs', 'exportTab': '🎬 Export', 'zipImport': '1. Import a Voxalike pack (.zip)',
      'zipImport.help': 'Supports Voxalike and The Choicer Voicer scene archives', 'chooseZip': '⬆ Choose .ZIP archive',
      'customImport': '2. Video + subtitles', 'customImport.help': 'Upload MP4/MKV and ASS/SSA/SRT/VTT. MKV may contain its own subtitle track.',
      'videoFile': 'Video (.mp4 / .mkv):', 'subtitleFile': 'Subtitles (optional for MKV):', 'sceneTitle': 'Scene title (optional):',
      'sceneTitle.placeholder': 'My new scene…', 'createScene': '🚀 Create scene', 'library.help': 'Choose a previously uploaded pack:',
      'searchingPacks': 'Looking for packs…', 'videoExport': '1. Export finished video (WebCodecs)',
      'videoExport.help': 'Fast MP4 export with mixed audio in your browser', 'dubTrack': '🎙️ Recorded dubbing:',
      'backingTrack': '🎵 Background / ambience:', 'originalTrack': '🗣️ Original video audio:', 'rendering': '⏳ Exporting video…',
      'startExport': '▶ Export MP4 video', 'stemExport': '2. Character stems for REAPER (.zip)',
      'stemExport.help': 'Full-length WAV track per character, aligned from 0:00 with silence between lines',
      'downloadStems': '🎛️ Build and download WAV stems', 'sourcePack': '3. Original scene pack (.zip)',
      'sourcePack.help': 'Download the original ZIP for friends', 'downloadSource': '📥 Download original pack (.zip)',
      'sourceUnavailable': 'Archive unavailable (manual scene or no ZIP)', 'muteAll': '🔇 Mute all',
      'original': 'Original:', 'background': 'Background:', 'dubbing': 'Dubbing:', 'inspector.title': 'Line inspector',
      'inspector.empty': 'Select a line on the timeline to record it. (Space — play/pause, R — record)',
      'chat.title': '💬 Room chat', 'chat.empty': 'No messages yet. Say hello!', 'chat.placeholder': 'Message… (Enter)',
      'host.you': '👑 You are host', 'host.pause': '⏸ Pause everyone', 'host.reset': '♻ Reset roles',
      'host.offline': '👑 Host is offline', 'host.claim': 'Become host', 'host.name': '👑 Host: {name}',
      'nick.saved': 'Nickname saved', 'invite.copied': 'Invitation link copied.', 'onlyHost': 'Only the room host can do this.',
      'packs.loading': 'Loading packs…', 'packs.empty': 'No saved packs yet.', 'download': '📥 Download', 'launch': '▶ Launch',
      'uploading': 'Uploading and processing…', 'upload.done': 'Scene created.', 'stems.progress': 'Rendering {current}/{total}: {name}',
      'stems.mixing': 'Building full-length WAV stems…', 'stems.done': 'Stem archive downloaded.',
      'system.packLoaded': '🎬 Host loaded “{title}”', 'system.customScene': '🎬 Host created “{title}” ({count} lines)',
      'system.roleReleased': '👑 Host released “{character}” from {owner}', 'system.lineReleased': '👑 Host released line #{id} from {owner}',
      'system.claimsReset': '♻️ Host reset all roles and lines (recordings were kept)',
      'system.forcePause': '⏸ Host {nick} paused the video for everyone', 'system.newHost': '👑 {nick} is now the room host',
      'error.noScene': 'Load a scene first.', 'error.noTakes': 'There are no recorded takes to export.',
      'error.generic': 'Something went wrong: {message}', 'error.nickTaken': 'Nickname “{nick}” is already used in this room.', 'confirm.reset': 'Release all roles and lines? Recordings will be kept.',
      'confirm.delete': 'Delete this recording?', 'effect.none': 'No effect', 'effect.robot': '🤖 Robot',
      'effect.radio': '📻 Radio', 'effect.monster': '👹 Monster', 'effect.thoughts': '💭 Thoughts',
      'effect.cave': '🪨 Cave', 'effect.behindDoor': '🚪 Behind a door', 'effect.megaphone': '📣 Megaphone'
    },
    ru: {
      'app.title': 'Dubline — Совместная студия озвучки', 'app.subtitle': 'Совместная студия озвучки', 'room': 'Комната:', 'share': '🔗 Поделиться', 'share.title': 'Скопировать ссылку для друзей',
      'online': '👥 В сети:', 'files': '📁 Файлы и Экспорт', 'settings': '⚙️ Настройки', 'chat': '💬 Чат',
      'welcome': '🎙️ Добро пожаловать в Dubline', 'welcome.help': 'Введите никнейм, чтобы друзья видели, кто какие роли занял:',
      'nickname.placeholder': 'Ваш никнейм…', 'enterStudio': 'Войти в студию', 'settings.title': '⚙️ Настройки студии',
      'close': 'Закрыть', 'userTab': '👤 Пользователь', 'playerTab': '🎛️ Плеер и Комната', 'nickname': 'Ваш никнейм в комнате',
      'nickname.help': 'Отображается на ваших репликах и в чате', 'save': 'Сохранить', 'micGain': 'Чувствительность микрофона (Gain)',
      'micGain.help': 'Усиление звука для тихих гарнитур и микрофонов', 'noiseSuppression': 'Шумоподавление и эхоподавление браузера',
      'noiseSuppression.help': 'Встроенная обработка микрофона WebRTC', 'language': 'Язык', 'language.help': 'Язык интерфейса на этом устройстве',
      'autoDuck': 'Автодакинг', 'autoDuck.help': 'Приглушает фон и оригинал во время звучания дублей', 'duckAmount': 'Сила приглушения фона:',
      'prompter': 'Суфлёр на видео', 'prompter.help': 'Показывает текущую реплику и персонажа поверх видео', 'prompterSize': 'Размер шрифта субтитров:',
      'files.title': '📁 Файлы и Экспорт', 'importTab': '⬆ Импорт', 'libraryTab': '📂 Моды на сервере', 'exportTab': '🎬 Экспорт',
      'zipImport': '1. Загрузка пака Voxalike (.zip)', 'zipImport.help': 'Поддерживаются архивы сцен Voxalike и The Choicer Voicer',
      'chooseZip': '⬆ Выбрать .ZIP архив', 'customImport': '2. Видео + субтитры',
      'customImport.help': 'Загрузите MP4/MKV и ASS/SSA/SRT/VTT. MKV может содержать встроенные субтитры.',
      'videoFile': 'Видео (.mp4 / .mkv):', 'subtitleFile': 'Субтитры (необязательно для MKV):', 'sceneTitle': 'Название сцены (необязательно):',
      'sceneTitle.placeholder': 'Моя новая сцена…', 'createScene': '🚀 Создать сцену', 'library.help': 'Выберите ранее загруженный мод:',
      'searchingPacks': 'Поиск модов…', 'videoExport': '1. Экспорт готового видео (WebCodecs)',
      'videoExport.help': 'Быстрый экспорт MP4 со сведённым звуком прямо в браузере', 'dubTrack': '🎙️ Записанный дубляж:',
      'backingTrack': '🎵 Интершум / фон:', 'originalTrack': '🗣️ Оригинальный звук видео:', 'rendering': '⏳ Идёт экспорт видео…',
      'startExport': '▶ Экспортировать видео MP4', 'stemExport': '2. Стемы персонажей для REAPER (.zip)',
      'stemExport.help': 'Цельный WAV каждого персонажа от 0:00 с тишиной между репликами', 'downloadStems': '🎛️ Создать и скачать WAV-стемы',
      'sourcePack': '3. Исходный мод сцены (.zip)', 'sourcePack.help': 'Скачать исходный ZIP для друзей',
      'downloadSource': '📥 Скачать исходный архив (.zip)', 'sourceUnavailable': 'Архив недоступен (ручная сцена или нет ZIP)',
      'muteAll': '🔇 Замутить всё', 'original': 'Оригинал:', 'background': 'Интершум:', 'dubbing': 'Дубляж:',
      'inspector.title': 'Инспектор реплики', 'inspector.empty': 'Выберите реплику на таймлайне для записи. (Пробел — плей/пауза, R — запись)',
      'chat.title': '💬 Чат комнаты', 'chat.empty': 'Сообщений пока нет. Напишите первым!', 'chat.placeholder': 'Сообщение… (Enter)',
      'host.you': '👑 Вы хост', 'host.pause': '⏸ Пауза у всех', 'host.reset': '♻ Сбросить роли', 'host.offline': '👑 Хост не в сети',
      'host.claim': 'Стать хостом', 'host.name': '👑 Хост: {name}', 'nick.saved': 'Никнейм сохранён', 'invite.copied': 'Ссылка на комнату скопирована.',
      'onlyHost': 'Действие доступно только хосту комнаты.', 'packs.loading': 'Загрузка списка модов…', 'packs.empty': 'На сервере пока нет модов.',
      'download': '📥 Скачать', 'launch': '▶ Запустить', 'uploading': 'Загрузка и обработка…', 'upload.done': 'Сцена создана.',
      'stems.progress': 'Рендер {current}/{total}: {name}', 'stems.mixing': 'Создаю цельные WAV-стемы…', 'stems.done': 'Архив стемов скачан.',
      'system.packLoaded': '🎬 Хост запустил пак «{title}»', 'system.customScene': '🎬 Хост создал сцену «{title}» ({count} реплик)',
      'system.roleReleased': '👑 Хост снял роль «{character}» с игрока {owner}', 'system.lineReleased': '👑 Хост освободил реплику #{id} игрока {owner}',
      'system.claimsReset': '♻️ Хост сбросил все роли и реплики (дубли сохранены)', 'system.forcePause': '⏸ Хост {nick} поставил видео на паузу у всех',
      'system.newHost': '👑 {nick} теперь хост комнаты', 'error.noScene': 'Сначала загрузите сцену.',
      'error.noTakes': 'Нет записанных дублей для экспорта.', 'error.generic': 'Произошла ошибка: {message}', 'error.nickTaken': 'Ник «{nick}» уже занят в этой комнате.',
      'confirm.reset': 'Освободить все роли и реплики? Записанные дубли останутся.', 'confirm.delete': 'Удалить эту запись дубля?',
      'effect.none': 'Без эффекта', 'effect.robot': '🤖 Робот', 'effect.radio': '📻 Рация', 'effect.monster': '👹 Монстр',
      'effect.thoughts': '💭 Мысли', 'effect.cave': '🪨 Пещера', 'effect.behindDoor': '🚪 За дверью', 'effect.megaphone': '📣 Мегафон'
    },
    uk: {
      'app.title': 'Dubline — Спільна студія озвучення', 'app.subtitle': 'Спільна студія озвучення', 'room': 'Кімната:', 'share': '🔗 Поділитися', 'share.title': 'Скопіювати запрошення',
      'online': '👥 Онлайн:', 'files': '📁 Файли та Експорт', 'settings': '⚙️ Налаштування', 'chat': '💬 Чат',
      'welcome': '🎙️ Ласкаво просимо до Dubline', 'welcome.help': 'Оберіть нікнейм, щоб друзі бачили, хто взяв роль:',
      'nickname.placeholder': 'Ваш нікнейм…', 'enterStudio': 'Увійти до студії', 'settings.title': '⚙️ Налаштування студії',
      'close': 'Закрити', 'userTab': '👤 Користувач', 'playerTab': '🎛️ Плеєр і Кімната', 'nickname': 'Ваш нікнейм у кімнаті',
      'nickname.help': 'Відображається на репліках і в чаті', 'save': 'Зберегти', 'micGain': 'Підсилення мікрофона',
      'micGain.help': 'Підсилення тихих гарнітур і мікрофонів', 'noiseSuppression': 'Шумозаглушення та ехоприглушення',
      'noiseSuppression.help': 'Вбудована обробка мікрофона WebRTC', 'language': 'Мова', 'language.help': 'Мова інтерфейсу на цьому пристрої',
      'autoDuck': 'Автодакінг', 'autoDuck.help': 'Приглушує фон і оригінал під час звучання дублів', 'duckAmount': 'Сила приглушення фону:',
      'prompter': 'Суфлер на відео', 'prompter.help': 'Показує поточну репліку та персонажа поверх відео', 'prompterSize': 'Розмір шрифту субтитрів:',
      'files.title': '📁 Файли та Експорт', 'importTab': '⬆ Імпорт', 'libraryTab': '📂 Моди на сервері', 'exportTab': '🎬 Експорт',
      'zipImport': '1. Завантаження паку Voxalike (.zip)', 'zipImport.help': 'Підтримуються архіви Voxalike і The Choicer Voicer',
      'chooseZip': '⬆ Обрати .ZIP архів', 'customImport': '2. Відео + субтитри',
      'customImport.help': 'Завантажте MP4/MKV та ASS/SSA/SRT/VTT. MKV може містити вбудовані субтитри.',
      'videoFile': 'Відео (.mp4 / .mkv):', 'subtitleFile': 'Субтитри (необов’язково для MKV):', 'sceneTitle': 'Назва сцени (необов’язково):',
      'sceneTitle.placeholder': 'Моя нова сцена…', 'createScene': '🚀 Створити сцену', 'library.help': 'Оберіть раніше завантажений мод:',
      'searchingPacks': 'Пошук модів…', 'videoExport': '1. Експорт готового відео (WebCodecs)', 'videoExport.help': 'Швидкий експорт MP4 зі зведеним звуком у браузері',
      'dubTrack': '🎙️ Записане озвучення:', 'backingTrack': '🎵 Інтершум / фон:', 'originalTrack': '🗣️ Оригінальний звук відео:',
      'rendering': '⏳ Експорт відео…', 'startExport': '▶ Експортувати MP4', 'stemExport': '2. Стеми персонажів для REAPER (.zip)',
      'stemExport.help': 'Повний WAV кожного персонажа від 0:00 із тишею між репліками', 'downloadStems': '🎛️ Створити й завантажити WAV-стеми',
      'sourcePack': '3. Початковий мод сцени (.zip)', 'sourcePack.help': 'Завантажити початковий ZIP для друзів',
      'downloadSource': '📥 Завантажити початковий архів (.zip)', 'sourceUnavailable': 'Архів недоступний (ручна сцена або немає ZIP)',
      'muteAll': '🔇 Вимкнути все', 'original': 'Оригінал:', 'background': 'Інтершум:', 'dubbing': 'Озвучення:',
      'inspector.title': 'Інспектор репліки', 'inspector.empty': 'Оберіть репліку на таймлайні. (Пробіл — відтворення/пауза, R — запис)',
      'chat.title': '💬 Чат кімнати', 'chat.empty': 'Повідомлень ще немає. Напишіть першим!', 'chat.placeholder': 'Повідомлення… (Enter)',
      'host.you': '👑 Ви хост', 'host.pause': '⏸ Пауза для всіх', 'host.reset': '♻ Скинути ролі', 'host.offline': '👑 Хост не онлайн',
      'host.claim': 'Стати хостом', 'host.name': '👑 Хост: {name}', 'nick.saved': 'Нікнейм збережено', 'invite.copied': 'Посилання скопійовано.',
      'onlyHost': 'Дія доступна лише хосту кімнати.', 'packs.loading': 'Завантаження модів…', 'packs.empty': 'На сервері ще немає модів.',
      'download': '📥 Завантажити', 'launch': '▶ Запустити', 'uploading': 'Завантаження та обробка…', 'upload.done': 'Сцену створено.',
      'stems.progress': 'Рендер {current}/{total}: {name}', 'stems.mixing': 'Створюю повні WAV-стеми…', 'stems.done': 'Архів стемів завантажено.',
      'system.packLoaded': '🎬 Хост запустив пак «{title}»', 'system.customScene': '🎬 Хост створив сцену «{title}» ({count} реплік)',
      'system.roleReleased': '👑 Хост звільнив роль «{character}» гравця {owner}', 'system.lineReleased': '👑 Хост звільнив репліку #{id} гравця {owner}',
      'system.claimsReset': '♻️ Хост скинув усі ролі та репліки (записи збережено)', 'system.forcePause': '⏸ Хост {nick} поставив відео на паузу для всіх',
      'system.newHost': '👑 {nick} тепер хост кімнати', 'error.noScene': 'Спочатку завантажте сцену.',
      'error.noTakes': 'Немає записаних дублів для експорту.', 'error.generic': 'Сталася помилка: {message}', 'error.nickTaken': 'Нік «{nick}» уже зайнятий у цій кімнаті.',
      'confirm.reset': 'Звільнити всі ролі та репліки? Записи залишаться.', 'confirm.delete': 'Видалити цей запис?',
      'effect.none': 'Без ефекту', 'effect.robot': '🤖 Робот', 'effect.radio': '📻 Рація', 'effect.monster': '👹 Монстр',
      'effect.thoughts': '💭 Думки', 'effect.cave': '🪨 Печера', 'effect.behindDoor': '🚪 За дверима', 'effect.megaphone': '📣 Мегафон'
    }
  };

  Object.assign(messages.en, {
    'line': 'Line', 'timing': 'Timing:', 'status': 'Status:', 'owned.you': '✅ Claimed by you', 'owned.role': '(role)',
    'owned.other': '🔒 Claimed by {owner}', 'free': '⚪ Free to record', 'claim.line': '🙋 Claim this line',
    'claim.role': '🎭 Claim role ({character})', 'release.line': '❌ Release line', 'release.role': '🚪 Release role ({character})',
    'host.releaseRole': '👑 Release role from {owner}', 'host.releaseLine': '👑 Release line from {owner}',
    'record': '🎙️ Record take (R)', 'playTake': '▶ Take', 'rerecord': 'Record again (R)', 'listenTake': '▶ Listen to {owner}’s take',
    'claimFirst': 'Claim the line before recording', 'micLevel': '🎙️ Microphone gain:', 'listenOriginal': '🎧 Listen to original',
    'voice': '🎚 Voice:', 'pitch': 'Pitch:', 'trim': '✂ Trim silence', 'speech': 'speech {from}–{to}s', 'speechMissing': 'speech not detected',
    'shift': 'Shift:', 'earlier': '◀ 50ms', 'later': '50ms ▶', 'reset': 'Reset', 'dragHint': 'Drag the take directly on the timeline',
    'recordedBy': 'Recorded by {owner}', 'error.mic': 'Microphone access was denied.', 'error.take': 'Could not load the take.',
    'error.notOwner': 'You cannot record a line claimed by someone else.', 'error.emptyAudio': 'The microphone recorded an empty file.',
    'render.readVideo': 'Reading video…', 'render.decodeBackground': 'Decoding background…', 'render.decodeOriginal': 'Decoding original audio…',
    'render.takes': 'Processing takes ({current}/{total})…', 'render.mix': 'Mixing audio…', 'render.finalize': 'Finalizing file…',
    'rolesTrack': 'Roles & characters', 'linesTrack': 'Lines', 'claimRoleShort': '+ Claim role', 'you': 'You', 'lineFallback': '(line)',
    'dragTitle': 'Drag to shift this take', 'record.retry': '🎙️ Record again', 'record.trim': '✂ Detecting speech…',
    'record.saving': 'Saving…', 'record.preparing': '⏳ Get ready (recording is active)…', 'record.speak': '🔴 SPEAK! (Stop)',
    'record.processing': '⏳ Processing audio…', 'render.fallback': 'WebCodecs failed; recording in real time…',
    'render.done': '✅ Video saved in {seconds}s!', 'render.error': '❌ Export failed: {message}',
    'render.noVideo': 'The scene has no video track', 'render.unknownCodec': 'Unknown video codec', 'render.noAudioCodec': 'This browser cannot encode audio with WebCodecs',
    'render.mp4Progress': 'Building MP4: {current}s / {total}s', 'render.realtimeProgress': 'Real-time recording: {current}s / {total}s'
  });
  Object.assign(messages.ru, {
    'line': 'Реплика', 'timing': 'Тайминг:', 'status': 'Статус:', 'owned.you': '✅ Занято вами', 'owned.role': '(роль)',
    'owned.other': '🔒 Занято игроком {owner}', 'free': '⚪ Свободно для записи', 'claim.line': '🙋 Занять эту реплику',
    'claim.role': '🎭 Взять всю роль ({character})', 'release.line': '❌ Освободить реплику', 'release.role': '🚪 Отказаться от роли ({character})',
    'host.releaseRole': '👑 Снять роль с игрока {owner}', 'host.releaseLine': '👑 Освободить реплику игрока {owner}',
    'record': '🎙️ Записать дубль (R)', 'playTake': '▶ Дубль', 'rerecord': 'Переписать (R)', 'listenTake': '▶ Послушать дубль игрока {owner}',
    'claimFirst': 'Сначала займите реплику для записи', 'micLevel': '🎙️ Громкость микрофона:', 'listenOriginal': '🎧 Слушать оригинал',
    'voice': '🎚 Голос:', 'pitch': 'Питч:', 'trim': '✂ Обрезать тишину', 'speech': 'речь {from}–{to}с', 'speechMissing': 'речь не найдена',
    'shift': 'Сдвиг:', 'earlier': '◀ 50мс', 'later': '50мс ▶', 'reset': 'Сброс', 'dragHint': 'Дубль можно перетащить мышкой по таймлайну',
    'recordedBy': 'Записал {owner}', 'error.mic': 'Нет доступа к микрофону.', 'error.take': 'Не удалось загрузить дубль.',
    'error.notOwner': 'Нельзя записывать реплику другого игрока.', 'error.emptyAudio': 'Микрофон записал пустой файл.',
    'render.readVideo': 'Читаю видео…', 'render.decodeBackground': 'Декодирую интершум…', 'render.decodeOriginal': 'Декодирую оригинальный звук…',
    'render.takes': 'Обрабатываю дубли ({current}/{total})…', 'render.mix': 'Свожу звук…', 'render.finalize': 'Финализирую файл…',
    'rolesTrack': 'Роли и персонажи', 'linesTrack': 'Дорожка реплик', 'claimRoleShort': '+ Взять роль', 'you': 'Вы', 'lineFallback': '(реплика)',
    'dragTitle': 'Перетащите, чтобы сдвинуть дубль', 'record.retry': '🎙️ Повторить запись', 'record.trim': '✂ Ищу речь…',
    'record.saving': 'Сохранение…', 'record.preparing': '⏳ Подготовка (запись уже идёт)…', 'record.speak': '🔴 ГОВОРИТЕ! (Стоп)',
    'record.processing': '⏳ Обработка звука…', 'render.fallback': 'WebCodecs не справился, пишу в реальном времени…',
    'render.done': '✅ Видео сохранено за {seconds}с!', 'render.error': '❌ Ошибка рендера: {message}',
    'render.noVideo': 'В сцене нет видеодорожки', 'render.unknownCodec': 'Неизвестный видеокодек', 'render.noAudioCodec': 'Браузер не умеет кодировать звук через WebCodecs',
    'render.mp4Progress': 'Собираю MP4: {current}с / {total}с', 'render.realtimeProgress': 'Запись в реальном времени: {current}с / {total}с'
  });
  Object.assign(messages.uk, {
    'line': 'Репліка', 'timing': 'Таймінг:', 'status': 'Статус:', 'owned.you': '✅ Зайнято вами', 'owned.role': '(роль)',
    'owned.other': '🔒 Зайнято гравцем {owner}', 'free': '⚪ Вільно для запису', 'claim.line': '🙋 Зайняти цю репліку',
    'claim.role': '🎭 Взяти всю роль ({character})', 'release.line': '❌ Звільнити репліку', 'release.role': '🚪 Відмовитися від ролі ({character})',
    'host.releaseRole': '👑 Зняти роль із гравця {owner}', 'host.releaseLine': '👑 Звільнити репліку гравця {owner}',
    'record': '🎙️ Записати дубль (R)', 'playTake': '▶ Дубль', 'rerecord': 'Перезаписати (R)', 'listenTake': '▶ Прослухати дубль гравця {owner}',
    'claimFirst': 'Спочатку займіть репліку', 'micLevel': '🎙️ Підсилення мікрофона:', 'listenOriginal': '🎧 Слухати оригінал',
    'voice': '🎚 Голос:', 'pitch': 'Пітч:', 'trim': '✂ Обрізати тишу', 'speech': 'мова {from}–{to}с', 'speechMissing': 'мову не знайдено',
    'shift': 'Зсув:', 'earlier': '◀ 50мс', 'later': '50мс ▶', 'reset': 'Скинути', 'dragHint': 'Дубль можна перетягнути на таймлайні',
    'recordedBy': 'Записав {owner}', 'error.mic': 'Немає доступу до мікрофона.', 'error.take': 'Не вдалося завантажити дубль.',
    'error.notOwner': 'Не можна записувати репліку іншого гравця.', 'error.emptyAudio': 'Мікрофон записав порожній файл.',
    'render.readVideo': 'Читаю відео…', 'render.decodeBackground': 'Декодую фон…', 'render.decodeOriginal': 'Декодую оригінальний звук…',
    'render.takes': 'Обробляю дублі ({current}/{total})…', 'render.mix': 'Зводжу звук…', 'render.finalize': 'Завершую файл…',
    'rolesTrack': 'Ролі та персонажі', 'linesTrack': 'Доріжка реплік', 'claimRoleShort': '+ Взяти роль', 'you': 'Ви', 'lineFallback': '(репліка)',
    'dragTitle': 'Перетягніть, щоб зсунути дубль', 'record.retry': '🎙️ Повторити запис', 'record.trim': '✂ Шукаю мовлення…',
    'record.saving': 'Збереження…', 'record.preparing': '⏳ Підготовка (запис уже триває)…', 'record.speak': '🔴 ГОВОРІТЬ! (Стоп)',
    'record.processing': '⏳ Обробка звуку…', 'render.fallback': 'WebCodecs не впорався, записую в реальному часі…',
    'render.done': '✅ Відео збережено за {seconds}с!', 'render.error': '❌ Помилка експорту: {message}',
    'render.noVideo': 'У сцені немає відеодоріжки', 'render.unknownCodec': 'Невідомий відеокодек', 'render.noAudioCodec': 'Браузер не може кодувати звук через WebCodecs',
    'render.mp4Progress': 'Збираю MP4: {current}с / {total}с', 'render.realtimeProgress': 'Запис у реальному часі: {current}с / {total}с'
  });

  let language = localStorage.getItem('dubline_language');
  if (!messages[language]) {
    const browser = String(navigator.language || 'en').toLowerCase();
    language = browser.startsWith('uk') ? 'uk' : browser.startsWith('ru') ? 'ru' : 'en';
  }

  function t(key, params = {}) {
    const template = messages[language][key] || messages.en[key] || key;
    return template.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`);
  }

  function apply(root = document) {
    document.documentElement.lang = language;
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  }

  function setLanguage(next) {
    if (!messages[next]) return;
    language = next;
    localStorage.setItem('dubline_language', language);
    apply();
    window.dispatchEvent(new CustomEvent('dubline-language-changed', { detail: language }));
  }

  window.DublineI18n = { t, apply, setLanguage, getLanguage: () => language, messages };
})();
