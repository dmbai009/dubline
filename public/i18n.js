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
    'record': '🎙️ Record take (R)', 'playTake': '▶ Take', 'rerecord': 'Record again (R)', 'listenTake': '▶ Listen to {owner}’s take', 'listenTakeAnon': '▶ Listen to the take',
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
    'record': '🎙️ Записать дубль (R)', 'playTake': '▶ Дубль', 'rerecord': 'Переписать (R)', 'listenTake': '▶ Послушать дубль игрока {owner}', 'listenTakeAnon': '▶ Послушать дубль',
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
    'record': '🎙️ Записати дубль (R)', 'playTake': '▶ Дубль', 'rerecord': 'Перезаписати (R)', 'listenTake': '▶ Прослухати дубль гравця {owner}', 'listenTakeAnon': '▶ Прослухати дубль',
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

  Object.assign(messages.en, {
    'conn.lost': "🔴 No connection to the server. Reconnecting…",
    'conn.attempt': "(attempt {n})",
    'conn.restored': "🟢 Connection restored",
    'recording.title': "{nick} is recording this line right now",
    'mb': "{value} MB",
    'host.pauseConfirm': "Recording right now: {names}. Pause anyway? Their take will not be saved.",
    'host.watch': "🎬 Watch together",
    'host.watchStop': "⏹ Stop watching",
    'host.watchConfirm': "Play the video from the start for everyone, with all takes?",
    'watch.banner': "🎬 Watching together",
    'watch.hostControls': "the host controls playback",
    'watch.leave': "Leave",
    'watch.noRecord': "Recording is unavailable while watching together",
    'system.watchStart': "🎬 {nick} started watching together",
    'system.watchStop': "⏹ {nick} stopped watching together",
    'downloadSourceSized': "📥 Download source pack (.zip) — {size}",
    'downloadVideo': "🎞️ Download scene video — {size}",
    'localMedia': "4. Video from your disk",
    'localMedia.help': "Saves the host’s internet: choose the pack .zip or video you downloaded earlier, and the video plays from your computer instead of through the tunnel.",
    'localMedia.choose': "📂 Choose .zip or video",
    'localMedia.active': "✅ Video plays from your disk ({size})",
    'localMedia.inactive': "Video is streamed from the host’s computer",
    'localMedia.reading': "Reading file…",
    'localMedia.notFound': "No scene video found in this archive",
    'localMedia.mismatch': "This file differs from the scene video ({local} vs {remote}). Use it anyway?",
    'localMedia.reset': "Stream from host again"
  });
  Object.assign(messages.ru, {
    'conn.lost': "🔴 Нет связи с сервером. Переподключаемся…",
    'conn.attempt': "(попытка {n})",
    'conn.restored': "🟢 Связь восстановлена",
    'recording.title': "{nick} сейчас записывает эту реплику",
    'mb': "{value} МБ",
    'host.pauseConfirm': "Сейчас записывают: {names}. Всё равно поставить паузу? Их дубль не сохранится.",
    'host.watch': "🎬 Смотрим вместе",
    'host.watchStop': "⏹ Остановить просмотр",
    'host.watchConfirm': "Запустить ролик с начала у всех одновременно, со всеми дублями?",
    'watch.banner': "🎬 Смотрим вместе",
    'watch.hostControls': "управляет хост",
    'watch.leave': "Выйти",
    'watch.noRecord': "Во время совместного просмотра запись недоступна",
    'system.watchStart': "🎬 {nick} запустил совместный просмотр",
    'system.watchStop': "⏹ {nick} остановил совместный просмотр",
    'downloadSourceSized': "📥 Скачать исходный архив мода (.zip) — {size}",
    'downloadVideo': "🎞️ Скачать видео сцены — {size}",
    'localMedia': "4. Видео с вашего диска",
    'localMedia.help': "Экономит интернет хоста: выберите скачанный ранее .zip пака или видео, и ролик будет играть с вашего компьютера, а не через туннель.",
    'localMedia.choose': "📂 Выбрать .zip или видео",
    'localMedia.active': "✅ Видео играет с вашего диска ({size})",
    'localMedia.inactive': "Видео идёт с компьютера хоста",
    'localMedia.reading': "Читаю файл…",
    'localMedia.notFound': "В архиве не найдено видео сцены",
    'localMedia.mismatch': "Этот файл отличается от видео сцены ({local} против {remote}). Всё равно использовать?",
    'localMedia.reset': "Снова брать с хоста"
  });
  Object.assign(messages.uk, {
    'conn.lost': "🔴 Немає зв’язку із сервером. Перепідключаємося…",
    'conn.attempt': "(спроба {n})",
    'conn.restored': "🟢 Зв’язок відновлено",
    'recording.title': "{nick} зараз записує цю репліку",
    'mb': "{value} МБ",
    'host.pauseConfirm': "Зараз записують: {names}. Усе одно поставити паузу? Їхній дубль не збережеться.",
    'host.watch': "🎬 Дивимося разом",
    'host.watchStop': "⏹ Зупинити перегляд",
    'host.watchConfirm': "Запустити ролик з початку в усіх одночасно, з усіма дублями?",
    'watch.banner': "🎬 Дивимося разом",
    'watch.hostControls': "керує хост",
    'watch.leave': "Вийти",
    'watch.noRecord': "Під час спільного перегляду запис недоступний",
    'system.watchStart': "🎬 {nick} запустив спільний перегляд",
    'system.watchStop': "⏹ {nick} зупинив спільний перегляд",
    'downloadSourceSized': "📥 Завантажити архів мода (.zip) — {size}",
    'downloadVideo': "🎞️ Завантажити відео сцени — {size}",
    'localMedia': "4. Відео з вашого диска",
    'localMedia.help': "Економить інтернет хоста: виберіть завантажений раніше .zip пака або відео, і ролик гратиме з вашого комп’ютера, а не через тунель.",
    'localMedia.choose': "📂 Вибрати .zip або відео",
    'localMedia.active': "✅ Відео грає з вашого диска ({size})",
    'localMedia.inactive': "Відео йде з комп’ютера хоста",
    'localMedia.reading': "Читаю файл…",
    'localMedia.notFound': "В архіві не знайдено відео сцени",
    'localMedia.mismatch': "Цей файл відрізняється від відео сцени ({local} проти {remote}). Усе одно використати?",
    'localMedia.reset': "Знову брати з хоста"
  });

  Object.assign(messages.en, {
    'lobby.title': "Players",
    'progress.scene': "Dubbed",
    'lobby.online': "Online · {n}",
    'lobby.offline': "Offline · {n}",
    'lobby.recorded': "🎙 {n} recorded",
    'lobby.claimed': "🎭 {n} claimed",
    'lobby.recording': "🔴 recording #{id}",
    'lobby.seeding': "⚡ sharing video",
    'lobby.host': "host",
    'lobby.you': "you",
    'latency.label': "⏱ Delay",
    'latency.value': "{ms} ms",
    'latency.help': "If your takes sound late (e.g. Bluetooth headphones), increase the delay. It applies to all your takes. You can also Shift+drag any of your takes on the timeline.",
    'splitter.hint': "Drag to resize · double-click to reset",
    'timeline.hint': "Ctrl+wheel — zoom · Shift+drag your take — microphone delay",
    'zoom.in': "Zoom in",
    'zoom.out': "Zoom out",
    'zoom.fit': "⤢ Whole scene",
    'p2p.setting': "Share video with friends (P2P)",
    'p2p.setting.help': "When you have the scene video, you pass it to other players directly in pieces, so the host does not have to send it to everyone.",
    'layout.reset': "Panel layout",
    'layout.reset.help': "Resize panels by dragging the dividers; double-click a divider to reset it.",
    'p2p.fetching': "⚡ Loading video: {pct}% · from players {p2p} · from host {http}",
    'p2p.done': "⚡ Video loaded ({size}), {pct}% from players — you now help share it",
    'p2p.failed': "Could not preload the video, streaming from the host",
    'p2p.uploaded': "⚡ You have shared {size} with friends",
    'p2p.watchNow': "▶ Watch now from the host",
    'localMedia.activeP2p': "⚡ Video loaded to your browser ({size}) — you share it with others"
  });
  Object.assign(messages.ru, {
    'lobby.title': "Игроки",
    'progress.scene': "Озвучено",
    'lobby.online': "В сети · {n}",
    'lobby.offline': "Не в сети · {n}",
    'lobby.recorded': "🎙 записано {n}",
    'lobby.claimed': "🎭 занято {n}",
    'lobby.recording': "🔴 пишет #{id}",
    'lobby.seeding': "⚡ раздаёт видео",
    'lobby.host': "хост",
    'lobby.you': "вы",
    'latency.label': "⏱ Задержка",
    'latency.value': "{ms} мс",
    'latency.help': "Если ваши дубли звучат с опозданием (например, Bluetooth-наушники), увеличьте задержку. Она применяется ко всем вашим дублям. Ещё можно Shift+перетащить любой свой дубль на таймлайне.",
    'splitter.hint': "Перетащите, чтобы изменить размер · двойной клик — сброс",
    'timeline.hint': "Ctrl+колесо — масштаб · Shift+перетаскивание своего дубля — задержка микрофона",
    'zoom.in': "Увеличить",
    'zoom.out': "Уменьшить",
    'zoom.fit': "⤢ Вся сцена",
    'p2p.setting': "Раздавать видео друзьям (P2P)",
    'p2p.setting.help': "Когда у вас есть видео сцены, вы передаёте его другим игрокам напрямую по кусочкам — хосту не приходится раздавать его всем.",
    'layout.reset': "Раскладка панелей",
    'layout.reset.help': "Размеры панелей меняются перетаскиванием разделителей, двойной клик по разделителю — сброс.",
    'p2p.fetching': "⚡ Загружаю видео: {pct}% · от игроков {p2p} · с хоста {http}",
    'p2p.done': "⚡ Видео загружено ({size}), {pct}% от игроков — теперь вы помогаете раздавать его",
    'p2p.failed': "Не удалось загрузить видео заранее — смотрим напрямую с хоста",
    'p2p.uploaded': "⚡ Вы раздали друзьям {size}",
    'p2p.watchNow': "▶ Смотреть сразу с хоста",
    'localMedia.activeP2p': "⚡ Видео загружено к вам ({size}) — вы раздаёте его другим"
  });
  Object.assign(messages.uk, {
    'lobby.title': "Гравці",
    'progress.scene': "Озвучено",
    'lobby.online': "У мережі · {n}",
    'lobby.offline': "Не в мережі · {n}",
    'lobby.recorded': "🎙 записано {n}",
    'lobby.claimed': "🎭 зайнято {n}",
    'lobby.recording': "🔴 пише #{id}",
    'lobby.seeding': "⚡ роздає відео",
    'lobby.host': "хост",
    'lobby.you': "ви",
    'latency.label': "⏱ Затримка",
    'latency.value': "{ms} мс",
    'latency.help': "Якщо ваші дублі звучать із запізненням (наприклад, Bluetooth-навушники), збільште затримку. Вона застосовується до всіх ваших дублів. Ще можна Shift+перетягнути будь-який свій дубль на таймлайні.",
    'splitter.hint': "Перетягніть, щоб змінити розмір · подвійний клік — скидання",
    'timeline.hint': "Ctrl+коліщатко — масштаб · Shift+перетягування свого дубля — затримка мікрофона",
    'zoom.in': "Збільшити",
    'zoom.out': "Зменшити",
    'zoom.fit': "⤢ Уся сцена",
    'p2p.setting': "Роздавати відео друзям (P2P)",
    'p2p.setting.help': "Коли у вас є відео сцени, ви передаєте його іншим гравцям напряму частинами — хосту не доводиться роздавати його всім.",
    'layout.reset': "Розкладка панелей",
    'layout.reset.help': "Розміри панелей змінюються перетягуванням роздільників, подвійний клік по роздільнику — скидання.",
    'p2p.fetching': "⚡ Завантажую відео: {pct}% · від гравців {p2p} · з хоста {http}",
    'p2p.done': "⚡ Відео завантажено ({size}), {pct}% від гравців — тепер ви допомагаєте роздавати його",
    'p2p.failed': "Не вдалося завантажити відео заздалегідь — дивимося напряму з хоста",
    'p2p.uploaded': "⚡ Ви роздали друзям {size}",
    'p2p.watchNow': "▶ Дивитися одразу з хоста",
    'localMedia.activeP2p': "⚡ Відео завантажено до вас ({size}) — ви роздаєте його іншим"
  });

  Object.assign(messages.en, {
    'sessions.title': "🎬 Room sessions",
    'sessions.help': "Every import (pack, video + subtitles, or a mod from the library) creates a new session. Older sessions keep all their takes, and you can switch between them.",
    'sessions.empty': "No sessions yet — import a scene",
    'sessions.none': "No session",
    'sessions.onlyHost': "Only the host can switch, rename or delete sessions",
    'sessions.active': "open",
    'sessions.open': "▶ Open",
    'sessions.rename': "Rename",
    'sessions.delete': "Delete",
    'sessions.new': "➕ New session (import)",
    'sessions.progress': "{recorded}/{total} dubbed",
    'sessions.updated': "changed {date}",
    'sessions.kind.pack': "📦 Pack",
    'sessions.kind.custom': "🎞️ Video + subtitles",
    'sessions.renamePrompt': "New session name:",
    'sessions.deleteConfirm': "Delete session “{title}”?\n\nIts {takes} takes and scene files will be deleted permanently. The pack archive in the mod library stays.\n\nThis cannot be undone.",
    'sessions.recordingConfirm': "Recording right now: {names}. Switch session anyway? Their takes will not be saved.",
    'system.sessionSwitched': "🎬 {nick} opened session “{title}”",
    'system.sessionDeleted': "🗑 {nick} deleted session “{title}” ({takes} takes)"
  });
  Object.assign(messages.ru, {
    'sessions.title': "🎬 Сессии комнаты",
    'sessions.help': "Каждый импорт (пак, видео + субтитры или мод из библиотеки) создаёт новую сессию. Старые сессии остаются со всеми дублями — между ними можно переключаться.",
    'sessions.empty': "Сессий пока нет — импортируйте сцену",
    'sessions.none': "Нет сессии",
    'sessions.onlyHost': "Переключать, переименовывать и удалять сессии может только хост",
    'sessions.active': "открыта",
    'sessions.open': "▶ Открыть",
    'sessions.rename': "Переименовать",
    'sessions.delete': "Удалить",
    'sessions.new': "➕ Новая сессия (импорт)",
    'sessions.progress': "{recorded}/{total} озвучено",
    'sessions.updated': "изменена {date}",
    'sessions.kind.pack': "📦 Пак",
    'sessions.kind.custom': "🎞️ Видео + субтитры",
    'sessions.renamePrompt': "Новое название сессии:",
    'sessions.deleteConfirm': "Удалить сессию «{title}»?\n\nЕё {takes} дублей и файлы сцены будут удалены безвозвратно. Архив пака в библиотеке модов останется.\n\nЭто нельзя отменить.",
    'sessions.recordingConfirm': "Сейчас записывают: {names}. Всё равно переключить сессию? Их дубли не сохранятся.",
    'system.sessionSwitched': "🎬 {nick} открыл сессию «{title}»",
    'system.sessionDeleted': "🗑 {nick} удалил сессию «{title}» ({takes} дублей)"
  });
  Object.assign(messages.uk, {
    'sessions.title': "🎬 Сесії кімнати",
    'sessions.help': "Кожен імпорт (пак, відео + субтитри або мод з бібліотеки) створює нову сесію. Старі сесії залишаються з усіма дублями — між ними можна перемикатися.",
    'sessions.empty': "Сесій поки немає — імпортуйте сцену",
    'sessions.none': "Немає сесії",
    'sessions.onlyHost': "Перемикати, перейменовувати та видаляти сесії може лише хост",
    'sessions.active': "відкрита",
    'sessions.open': "▶ Відкрити",
    'sessions.rename': "Перейменувати",
    'sessions.delete': "Видалити",
    'sessions.new': "➕ Нова сесія (імпорт)",
    'sessions.progress': "{recorded}/{total} озвучено",
    'sessions.updated': "змінена {date}",
    'sessions.kind.pack': "📦 Пак",
    'sessions.kind.custom': "🎞️ Відео + субтитри",
    'sessions.renamePrompt': "Нова назва сесії:",
    'sessions.deleteConfirm': "Видалити сесію «{title}»?\n\nЇї {takes} дублів і файли сцени буде видалено назавжди. Архів пака в бібліотеці модів залишиться.\n\nЦе не можна скасувати.",
    'sessions.recordingConfirm': "Зараз записують: {names}. Усе одно перемкнути сесію? Їхні дублі не збережуться.",
    'system.sessionSwitched': "🎬 {nick} відкрив сесію «{title}»",
    'system.sessionDeleted': "🗑 {nick} видалив сесію «{title}» ({takes} дублів)"
  });

  Object.assign(messages.en, {
    'cue.setting': "Visual countdown before recording",
    'cue.setting.help': "A bar and dots over the video show when to start speaking. No sound.",
    'cue.ready': "Get ready…",
    'cue.speak': "🔴 Speak!",
    'cue.finish': "You can stop",
    'record.hint': "After you press it, the video rewinds 2 seconds. Start speaking when “Speak!” appears over the video.",
    'toast.selectLine': "First select a line on the timeline",
    'toast.claimFirst': "First claim this line — “Claim” in the inspector",
    'error.mic': "No microphone access. Allow it: click the 🔒 icon left of the address bar → Microphone → Allow, then reload the page.",
    'help.title': "❓ How to play Dubline",
    'help.step1.title': "🎧 Put on headphones",
    'help.step1': "With speakers, the video sound leaks into your microphone and the take gets an echo.",
    'help.step2.title': "🙋 Claim a line",
    'help.step2': "Click a tile on the timeline below and choose “Claim this line” — or take the whole role. Other players’ lines are protected.",
    'help.step3.title': "🎙️ Record a take",
    'help.step3': "Press “Record” or R. The video rewinds 2 seconds: wait for the bar to cross the screen and “Speak!” to appear. Recording stops by itself; press the button again to stop earlier.",
    'help.step4.title': "▶ Listen back",
    'help.step4': "In the inspector on the right: “▶ Take”. Not happy — “Record again”. Voice effects and pitch are there too.",
    'help.step5.title': "↔ Fix the timing",
    'help.step5': "Drag a take along the timeline with the mouse. If all your takes are late (e.g. Bluetooth headphones), set the delay on your card on the left.",
    'help.step6.title': "🎬 Watch together",
    'help.step6': "When the lines are dubbed, the host presses “Watch together” and the video starts for everyone at once. The finished video is in “Files & Export”.",
    'help.hotkeys': "Hotkeys",
    'help.keys': "Space — play/pause · R — record the selected line · ← → — seek 3 s · Ctrl+wheel — timeline zoom · Esc — close windows",
    'help.ok': "Got it, let’s play!"
  });
  Object.assign(messages.ru, {
    'cue.setting': "Визуальный отсчёт перед записью",
    'cue.setting.help': "Полоска и точки над видео показывают, когда начинать говорить. Без звука.",
    'cue.ready': "Приготовьтесь…",
    'cue.speak': "🔴 Говорите!",
    'cue.finish': "Можно заканчивать",
    'record.hint': "После нажатия видео отмотается на 2 секунды назад. Начинайте говорить, когда над видео появится «Говорите!».",
    'toast.selectLine': "Сначала выберите реплику на таймлайне",
    'toast.claimFirst': "Сначала займите эту реплику — кнопка «Занять» в инспекторе",
    'error.mic': "Нет доступа к микрофону. Разрешите его: нажмите на значок 🔒 слева от адреса сайта → Микрофон → Разрешить, затем обновите страницу.",
    'help.title': "❓ Как играть в Dubline",
    'help.step1.title': "🎧 Наденьте наушники",
    'help.step1': "Если играть через колонки, звук видео попадёт в микрофон и в дубле будет эхо.",
    'help.step2.title': "🙋 Займите реплику",
    'help.step2': "Нажмите на плитку на таймлайне внизу и выберите «Занять эту реплику» — или возьмите сразу всю роль. Чужие реплики защищены от перезаписи.",
    'help.step3.title': "🎙️ Запишите дубль",
    'help.step3': "Нажмите «Записать» или R. Видео отмотается на 2 секунды назад: дождитесь, пока полоска пробежит по экрану и появится «Говорите!». Запись остановится сама; чтобы закончить раньше, нажмите кнопку ещё раз.",
    'help.step4.title': "▶ Послушайте",
    'help.step4': "В инспекторе справа — «▶ Дубль». Не понравилось — «Переписать». Там же голосовые эффекты и питч.",
    'help.step5.title': "↔ Подгоните по времени",
    'help.step5': "Дубль можно перетащить мышкой по таймлайну. Если опаздывают все ваши дубли (например, Bluetooth-наушники) — настройте задержку в своей карточке слева.",
    'help.step6.title': "🎬 Смотрите вместе",
    'help.step6': "Когда реплики озвучены, хост нажимает «Смотрим вместе» — ролик запустится у всех одновременно. Готовое видео — в «Файлы и экспорт».",
    'help.hotkeys': "Горячие клавиши",
    'help.keys': "Пробел — плей/пауза · R — записать выбранную реплику · ← → — перемотка на 3 с · Ctrl+колесо — масштаб таймлайна · Esc — закрыть окна",
    'help.ok': "Понятно, играем!"
  });
  Object.assign(messages.uk, {
    'cue.setting': "Візуальний відлік перед записом",
    'cue.setting.help': "Смужка й крапки над відео показують, коли починати говорити. Без звуку.",
    'cue.ready': "Приготуйтеся…",
    'cue.speak': "🔴 Говоріть!",
    'cue.finish': "Можна закінчувати",
    'record.hint': "Після натискання відео відмотається на 2 секунди назад. Починайте говорити, коли над відео з’явиться «Говоріть!».",
    'toast.selectLine': "Спочатку виберіть репліку на таймлайні",
    'toast.claimFirst': "Спочатку займіть цю репліку — кнопка «Зайняти» в інспекторі",
    'error.mic': "Немає доступу до мікрофона. Дозвольте його: натисніть на значок 🔒 ліворуч від адреси сайту → Мікрофон → Дозволити, потім оновіть сторінку.",
    'help.title': "❓ Як грати в Dubline",
    'help.step1.title': "🎧 Надягніть навушники",
    'help.step1': "Якщо грати через колонки, звук відео потрапить у мікрофон і в дублі буде луна.",
    'help.step2.title': "🙋 Займіть репліку",
    'help.step2': "Натисніть на плитку на таймлайні внизу й виберіть «Зайняти цю репліку» — або візьміть одразу всю роль. Чужі репліки захищені від перезапису.",
    'help.step3.title': "🎙️ Запишіть дубль",
    'help.step3': "Натисніть «Записати» або R. Відео відмотається на 2 секунди назад: дочекайтеся, поки смужка пробіжить екраном і з’явиться «Говоріть!». Запис зупиниться сам; щоб закінчити раніше, натисніть кнопку ще раз.",
    'help.step4.title': "▶ Послухайте",
    'help.step4': "В інспекторі праворуч — «▶ Дубль». Не сподобалося — «Перезаписати». Там же голосові ефекти й пітч.",
    'help.step5.title': "↔ Підженіть за часом",
    'help.step5': "Дубль можна перетягнути мишкою по таймлайну. Якщо запізнюються всі ваші дублі (наприклад, Bluetooth-навушники) — налаштуйте затримку у своїй картці ліворуч.",
    'help.step6.title': "🎬 Дивіться разом",
    'help.step6': "Коли репліки озвучено, хост натискає «Дивимося разом» — ролик запуститься в усіх одночасно. Готове відео — у «Файли й експорт».",
    'help.hotkeys': "Гарячі клавіші",
    'help.keys': "Пробіл — плей/пауза · R — записати вибрану репліку · ← → — перемотування на 3 с · Ctrl+коліщатко — масштаб таймлайну · Esc — закрити вікна",
    'help.ok': "Зрозуміло, граємо!"
  });

  Object.assign(messages.en, {
    'chip.you': "✅ yours",
    'chip.role': "🎭 your role",
    'chip.other': "🔒 {owner}",
    'chip.free': "free",
    'insp.original': "🎧 Original",
    'record.hint': "Recording starts after the countdown over the video — speak on “Speak!”."
  });
  Object.assign(messages.ru, {
    'chip.you': "✅ ваша",
    'chip.role': "🎭 ваша роль",
    'chip.other': "🔒 {owner}",
    'chip.free': "свободна",
    'insp.original': "🎧 Оригинал",
    'record.hint': "Запись начнётся после отсчёта над видео — говорите на «Говорите!»."
  });
  Object.assign(messages.uk, {
    'chip.you': "✅ ваша",
    'chip.role': "🎭 ваша роль",
    'chip.other': "🔒 {owner}",
    'chip.free': "вільна",
    'insp.original': "🎧 Оригінал",
    'record.hint': "Запис почнеться після відліку над відео — говоріть на «Говоріть!»."
  });

  Object.assign(messages.en, {
    'take.pending': "⏳ not sent",
    'take.pendingNotice': "⏳ The take has not reached the server yet. It is saved in your browser and will be sent automatically when the connection is back.",
    'take.sendNow': "Send now",
    'toast.takeQueued': "No connection — the take is saved in your browser and will be sent automatically",
    'toast.takeSent': "✅ The pending take has been delivered",
    'toast.takeDropped': "The take was not saved: {reason}",
    'unload.pendingTakes': "Some takes have not been sent yet"
  });
  Object.assign(messages.ru, {
    'take.pending': "⏳ не отправлен",
    'take.pendingNotice': "⏳ Дубль ещё не дошёл до сервера. Он сохранён в браузере и отправится сам, как только появится связь.",
    'take.sendNow': "Отправить сейчас",
    'toast.takeQueued': "Нет связи — дубль сохранён в браузере и отправится автоматически",
    'toast.takeSent': "✅ Неотправленный дубль доставлен",
    'toast.takeDropped': "Дубль не сохранён: {reason}",
    'unload.pendingTakes': "Есть дубли, которые ещё не отправлены"
  });
  Object.assign(messages.uk, {
    'take.pending': "⏳ не надіслано",
    'take.pendingNotice': "⏳ Дубль ще не дійшов до сервера. Він збережений у браузері й надішлеться сам, щойно з’явиться зв’язок.",
    'take.sendNow': "Надіслати зараз",
    'toast.takeQueued': "Немає зв’язку — дубль збережено в браузері, він надішлеться автоматично",
    'toast.takeSent': "✅ Ненадісланий дубль доставлено",
    'toast.takeDropped': "Дубль не збережено: {reason}",
    'unload.pendingTakes': "Є дублі, які ще не надіслано"
  });

  Object.assign(messages.en, {
    'pw.title': "🔒 This room is password-protected",
    'pw.help': "Ask the room host for the password",
    'pw.placeholder': "Password",
    'pw.enter': "Enter",
    'pw.wrong': "Wrong password",
    'pw.tooMany': "Too many attempts. Reload the page and try again.",
    'pw.setting': "🔒 Room password",
    'pw.setting.help': "New players enter it once. Players already in the room stay.",
    'pw.new': "New password",
    'pw.set': "Set",
    'pw.remove': "Remove",
    'pw.statusOn': "The room is password-protected",
    'pw.statusOff': "No password: anyone with the link can join",
    'pw.onlyHost': "only the host can change it",
    'pw.unban': "Let kicked players back ({n})",
    'pw.saved': "Password set",
    'kick.button': "Kick from the room",
    'kick.confirm': "Kick {nick} from the room? They can only come back if you allow it.",
    'kick.noPassword': "Tip: the room has no password, so they could rejoin from another browser. Set a password in Settings.",
    'kicked.title': "⛔ You were removed from the room",
    'kicked.help': "The host closed your access. You can come back only if they allow it.",
    'system.kicked': "⛔ {nick} was removed from the room",
    'system.passwordSet': "🔒 {nick} set a room password",
    'system.passwordRemoved': "🔓 {nick} removed the room password"
  });
  Object.assign(messages.ru, {
    'pw.title': "🔒 Комната защищена паролем",
    'pw.help': "Спросите пароль у хоста комнаты",
    'pw.placeholder': "Пароль",
    'pw.enter': "Войти",
    'pw.wrong': "Неверный пароль",
    'pw.tooMany': "Слишком много попыток. Обновите страницу и попробуйте снова.",
    'pw.setting': "🔒 Пароль комнаты",
    'pw.setting.help': "Новые игроки вводят его один раз. Те, кто уже в комнате, остаются.",
    'pw.new': "Новый пароль",
    'pw.set': "Установить",
    'pw.remove': "Убрать",
    'pw.statusOn': "Комната защищена паролем",
    'pw.statusOff': "Пароля нет: зайти может любой, у кого есть ссылка",
    'pw.onlyHost': "менять может только хост",
    'pw.unban': "Разрешить вернуться выгнанным ({n})",
    'pw.saved': "Пароль установлен",
    'kick.button': "Выгнать из комнаты",
    'kick.confirm': "Выгнать {nick} из комнаты? Вернуться он сможет, только если вы разрешите.",
    'kick.noPassword': "Совет: у комнаты нет пароля, поэтому можно зайти снова из другого браузера. Поставьте пароль в настройках.",
    'kicked.title': "⛔ Вас удалили из комнаты",
    'kicked.help': "Хост закрыл вам доступ. Вернуться можно, только если он разрешит.",
    'system.kicked': "⛔ {nick} удалён из комнаты",
    'system.passwordSet': "🔒 {nick} поставил пароль на комнату",
    'system.passwordRemoved': "🔓 {nick} убрал пароль комнаты"
  });
  Object.assign(messages.uk, {
    'pw.title': "🔒 Кімната захищена паролем",
    'pw.help': "Запитайте пароль у хоста кімнати",
    'pw.placeholder': "Пароль",
    'pw.enter': "Увійти",
    'pw.wrong': "Неправильний пароль",
    'pw.tooMany': "Забагато спроб. Оновіть сторінку й спробуйте знову.",
    'pw.setting': "🔒 Пароль кімнати",
    'pw.setting.help': "Нові гравці вводять його один раз. Ті, хто вже в кімнаті, залишаються.",
    'pw.new': "Новий пароль",
    'pw.set': "Встановити",
    'pw.remove': "Прибрати",
    'pw.statusOn': "Кімната захищена паролем",
    'pw.statusOff': "Пароля немає: зайти може будь-хто, у кого є посилання",
    'pw.onlyHost': "змінювати може лише хост",
    'pw.unban': "Дозволити повернутися вигнаним ({n})",
    'pw.saved': "Пароль встановлено",
    'kick.button': "Вигнати з кімнати",
    'kick.confirm': "Вигнати {nick} з кімнати? Повернутися він зможе, лише якщо ви дозволите.",
    'kick.noPassword': "Порада: у кімнати немає пароля, тож можна зайти знову з іншого браузера. Поставте пароль у налаштуваннях.",
    'kicked.title': "⛔ Вас видалили з кімнати",
    'kicked.help': "Хост закрив вам доступ. Повернутися можна, лише якщо він дозволить.",
    'system.kicked': "⛔ {nick} видалено з кімнати",
    'system.passwordSet': "🔒 {nick} поставив пароль на кімнату",
    'system.passwordRemoved': "🔓 {nick} прибрав пароль кімнати"
  });

  Object.assign(messages.en, {
    'cue.finish': "🔴 Finish your phrase — recording stops when you go quiet",
    'record.hint': "Recording starts after the countdown over the video — speak on “Speak!”. It stops by itself once you go quiet.",
    'help.step3': "Press “Record” or R. The video rewinds 2 seconds: wait for the bar to cross the screen and “Speak!” to appear. If your phrase is longer than the original, keep talking — recording stops once you go quiet. Press the button again to stop earlier."
  });
  Object.assign(messages.ru, {
    'cue.finish': "🔴 Договаривайте — запись закончится, когда замолчите",
    'record.hint': "Запись начнётся после отсчёта над видео — говорите на «Говорите!». Закончится сама, когда вы замолчите.",
    'help.step3': "Нажмите «Записать» или R. Видео отмотается на 2 секунды назад: дождитесь, пока полоска пробежит по экрану и появится «Говорите!». Если фраза длиннее оригинала — просто договаривайте: запись закончится, когда вы замолчите. Чтобы остановить раньше, нажмите кнопку ещё раз."
  });
  Object.assign(messages.uk, {
    'cue.finish': "🔴 Договорюйте — запис закінчиться, коли замовкнете",
    'record.hint': "Запис почнеться після відліку над відео — говоріть на «Говоріть!». Закінчиться сам, коли ви замовкнете.",
    'help.step3': "Натисніть «Записати» або R. Відео відмотається на 2 секунди назад: дочекайтеся, поки смужка пробіжить екраном і з’явиться «Говоріть!». Якщо фраза довша за оригінал — просто договорюйте: запис закінчиться, коли ви замовкнете. Щоб зупинити раніше, натисніть кнопку ще раз."
  });

  Object.assign(messages.en, {
    'tracks.original': "🎧 Original",
    'tracks.backing': "🎵 Background",
    'tracks.none': "— none —",
    'tracks.label': "Track {n}: {name}",
    'tracks.onlyHost': "the host chooses tracks",
    'tracks.preparing': "⏳ Preparing the video audio tracks…",
    'char.rename': "Change character (the line moves to their track)",
    'char.placeholder': "Character name",
    'char.roleTaken': "The role “{name}” is claimed by {owner} — only the host can move a line there"
  });
  Object.assign(messages.ru, {
    'tracks.original': "🎧 Оригинал",
    'tracks.backing': "🎵 Интершум",
    'tracks.none': "— нет —",
    'tracks.label': "Дорожка {n}: {name}",
    'tracks.onlyHost': "дорожки выбирает хост",
    'tracks.preparing': "⏳ Готовлю звуковые дорожки видео…",
    'char.rename': "Сменить персонажа (реплика переедет на его дорожку)",
    'char.placeholder': "Имя персонажа",
    'char.roleTaken': "Роль «{name}» занята игроком {owner} — перенести туда реплику может только хост"
  });
  Object.assign(messages.uk, {
    'tracks.original': "🎧 Оригінал",
    'tracks.backing': "🎵 Інтершум",
    'tracks.none': "— немає —",
    'tracks.label': "Доріжка {n}: {name}",
    'tracks.onlyHost': "доріжки вибирає хост",
    'tracks.preparing': "⏳ Готую звукові доріжки відео…",
    'char.rename': "Змінити персонажа (репліка переїде на його доріжку)",
    'char.placeholder': "Ім’я персонажа",
    'char.roleTaken': "Роль «{name}» зайнята гравцем {owner} — перенести туди репліку може лише хост"
  });

  Object.assign(messages.en, {
    'char.renameTrack': "Rename the whole track “{name}” (all its lines):",
    'char.trackRenamed': "“{from}” → “{to}”: {n} lines",
    'char.trackDenied': "Some lines of this track belong to other players — only the host can rename it",
    'multi.title': "{n} lines selected",
    'multi.more': "…and {n} more",
    'multi.assign': "Assign character",
    'multi.release': "👑 Release selected",
    'multi.clear': "Clear selection",
    'multi.hint': "Ctrl+click adds or removes a line, Shift+click selects a range, Esc clears the selection.",
    'multi.done': "Moved to “{name}”: {moved}.",
    'multi.skipped': "Skipped {n}: they belong to other players.",
    'help.keys': "Space — play/pause · R — record the selected line · ← → — seek 3 s · Ctrl/Shift+click — select several lines · Ctrl+wheel — timeline zoom · Esc — close windows"
  });
  Object.assign(messages.ru, {
    'char.renameTrack': "Переименовать всю дорожку «{name}» (все её реплики):",
    'char.trackRenamed': "«{from}» → «{to}»: {n} реплик",
    'char.trackDenied': "Часть реплик этой дорожки заняли другие игроки — переименовать её может только хост",
    'multi.title': "Выбрано реплик: {n}",
    'multi.more': "…и ещё {n}",
    'multi.assign': "Назначить персонажа",
    'multi.release': "👑 Освободить выбранные",
    'multi.clear': "Снять выделение",
    'multi.hint': "Ctrl+клик — добавить или убрать реплику, Shift+клик — выделить диапазон, Esc — снять выделение.",
    'multi.done': "Перенесено к «{name}»: {moved}.",
    'multi.skipped': "Пропущено {n}: их заняли другие игроки.",
    'help.keys': "Пробел — плей/пауза · R — записать выбранную реплику · ← → — перемотка на 3 с · Ctrl/Shift+клик — выделить несколько реплик · Ctrl+колесо — масштаб таймлайна · Esc — закрыть окна"
  });
  Object.assign(messages.uk, {
    'char.renameTrack': "Перейменувати всю доріжку «{name}» (усі її репліки):",
    'char.trackRenamed': "«{from}» → «{to}»: {n} реплік",
    'char.trackDenied': "Частину реплік цієї доріжки зайняли інші гравці — перейменувати її може лише хост",
    'multi.title': "Вибрано реплік: {n}",
    'multi.more': "…і ще {n}",
    'multi.assign': "Призначити персонажа",
    'multi.release': "👑 Звільнити вибрані",
    'multi.clear': "Зняти виділення",
    'multi.hint': "Ctrl+клік — додати або прибрати репліку, Shift+клік — виділити діапазон, Esc — зняти виділення.",
    'multi.done': "Перенесено до «{name}»: {moved}.",
    'multi.skipped': "Пропущено {n}: їх зайняли інші гравці.",
    'help.keys': "Пробіл — плей/пауза · R — записати вибрану репліку · ← → — перемотування на 3 с · Ctrl/Shift+клік — виділити кілька реплік · Ctrl+коліщатко — масштаб таймлайну · Esc — закрити вікна"
  });

  Object.assign(messages.en, {
    'char.apply': "Set",
    'line.delete': "🗑 Delete line",
    'line.deleteConfirm': "Delete {n} line(s) from this session? Their takes are deleted too. Use it for on-screen signs and other text that is not dubbed.",
    'multi.delete': "🗑 Delete selected"
  });
  Object.assign(messages.ru, {
    'char.apply': "Назначить",
    'line.delete': "🗑 Удалить реплику",
    'line.deleteConfirm': "Удалить реплик из этой сессии: {n}? Их дубли тоже удалятся. Подходит для надписей на экране и другого текста, который не озвучивают.",
    'multi.delete': "🗑 Удалить выбранные"
  });
  Object.assign(messages.uk, {
    'char.apply': "Призначити",
    'line.delete': "🗑 Видалити репліку",
    'line.deleteConfirm': "Видалити реплік із цієї сесії: {n}? Їхні дублі теж видаляться. Підходить для написів на екрані та іншого тексту, який не озвучують.",
    'multi.delete': "🗑 Видалити вибрані"
  });

  Object.assign(messages.en, {
    'undo.toast': "Deleted lines: {n}",
    'undo.action': "Undo (Ctrl+Z)",
    'undo.toolbar': "↶ Restore deleted ({n})",
    'undo.hint': "Undo the last line deletion (Ctrl+Z)",
    'undo.done': "Restored lines: {n}",
    'undo.nothing': "Nothing to undo",
    'help.keys': "Space — play/pause · R — record the selected line · ← → — seek 3 s · Ctrl/Shift+click — select several lines · Ctrl+Z — undo line deletion (host) · Ctrl+wheel — timeline zoom · Esc — close windows"
  });
  Object.assign(messages.ru, {
    'undo.toast': "Удалено реплик: {n}",
    'undo.action': "Отменить (Ctrl+Z)",
    'undo.toolbar': "↶ Вернуть удалённое ({n})",
    'undo.hint': "Отменить последнее удаление реплик (Ctrl+Z)",
    'undo.done': "Возвращено реплик: {n}",
    'undo.nothing': "Нечего отменять",
    'help.keys': "Пробел — плей/пауза · R — записать выбранную реплику · ← → — перемотка на 3 с · Ctrl/Shift+клик — выделить несколько реплик · Ctrl+Z — отменить удаление реплик (хост) · Ctrl+колесо — масштаб таймлайна · Esc — закрыть окна"
  });
  Object.assign(messages.uk, {
    'undo.toast': "Видалено реплік: {n}",
    'undo.action': "Скасувати (Ctrl+Z)",
    'undo.toolbar': "↶ Повернути видалене ({n})",
    'undo.hint': "Скасувати останнє видалення реплік (Ctrl+Z)",
    'undo.done': "Повернуто реплік: {n}",
    'undo.nothing': "Нічого скасовувати",
    'help.keys': "Пробіл — плей/пауза · R — записати вибрану репліку · ← → — перемотування на 3 с · Ctrl/Shift+клік — виділити кілька реплік · Ctrl+Z — скасувати видалення реплік (хост) · Ctrl+коліщатко — масштаб таймлайну · Esc — закрити вікна"
  });

  Object.assign(messages.en, {
    'trash.title': "🗑 Deleted lines",
    'trash.help': "Deleted lines of this session. Restore the ones you need — they go back to their place together with their takes.",
    'trash.hint': "Deleted lines — restore any of them (Ctrl+Z restores the last deletion)",
    'trash.button': "🗑 Deleted ({n})",
    'trash.filter': "Search by text or character",
    'trash.selectAll': "Select all found",
    'trash.restore': "↶ Restore selected ({n})",
    'trash.restoreAll': "Restore all ({n})",
    'trash.purge': "Delete forever ({n})",
    'trash.purgeConfirm': "Delete {n} line(s) forever? Takes among them: {takes}. This cannot be undone.",
    'trash.empty': "The trash is empty",
    'trash.nothingFound': "Nothing found"
  });
  Object.assign(messages.ru, {
    'trash.title': "🗑 Корзина реплик",
    'trash.help': "Удалённые реплики этой сессии. Верните нужные — они встанут на прежнее место вместе с дублем.",
    'trash.hint': "Корзина удалённых реплик — можно вернуть любую (Ctrl+Z возвращает последнее удаление)",
    'trash.button': "🗑 Корзина ({n})",
    'trash.filter': "Поиск по тексту или персонажу",
    'trash.selectAll': "Выбрать все найденные",
    'trash.restore': "↶ Вернуть выбранные ({n})",
    'trash.restoreAll': "Вернуть всё ({n})",
    'trash.purge': "Удалить навсегда ({n})",
    'trash.purgeConfirm': "Удалить навсегда реплик: {n}? Из них с дублями: {takes}. Это нельзя отменить.",
    'trash.empty': "Корзина пуста",
    'trash.nothingFound': "Ничего не найдено"
  });
  Object.assign(messages.uk, {
    'trash.title': "🗑 Кошик реплік",
    'trash.help': "Видалені репліки цієї сесії. Поверніть потрібні — вони стануть на попереднє місце разом із дублем.",
    'trash.hint': "Кошик видалених реплік — можна повернути будь-яку (Ctrl+Z повертає останнє видалення)",
    'trash.button': "🗑 Кошик ({n})",
    'trash.filter': "Пошук за текстом або персонажем",
    'trash.selectAll': "Вибрати всі знайдені",
    'trash.restore': "↶ Повернути вибрані ({n})",
    'trash.restoreAll': "Повернути все ({n})",
    'trash.purge': "Видалити назавжди ({n})",
    'trash.purgeConfirm': "Видалити назавжди реплік: {n}? З них із дублями: {takes}. Це не можна скасувати.",
    'trash.empty': "Кошик порожній",
    'trash.nothingFound': "Нічого не знайдено"
  });

  Object.assign(messages.en, {
    'prompter.more': "+{n} more at the same time"
  });
  Object.assign(messages.ru, {
    'prompter.more': "+ ещё {n} одновременно"
  });
  Object.assign(messages.uk, {
    'prompter.more': "+ ще {n} одночасно"
  });

  Object.assign(messages.en, {
    'warning.mkvCodec': "MKV is remuxed without video conversion. HEVC/H.265, especially 10-bit video, may not play in Chrome or Edge. H.264 is the safest choice.",
    'warning.longExport': "This scene is about {minutes} minutes long. Export runs in browser memory and may require several GB of RAM. For reliable export, split long episodes or films into shorter scenes.",
    'upload.tooBigTunnel': "The file is {size} MB, but uploads through the shared link are limited to about {max} MB. The host can upload it on their own computer by opening http://localhost:3000 (a pack .zip can also be put into the public/packs folder — it appears in the library).",
    'upload.rejectedByTunnel': "The shared link rejected the file as too large. The host can upload it on their own computer at http://localhost:3000.",
    'upload.networkFailed': "The upload was interrupted (the connection or tunnel dropped). Try again; large files are best uploaded by the host at http://localhost:3000.",
    'browser.useChrome': "Dubline works best in Chrome or Edge. In this browser recording, export, or video sharing may not work properly.",
    'help.step1': "With speakers, the video sound leaks into your microphone and the take gets an echo. Wired headphones are best: Bluetooth headsets drop to low sound quality while the microphone is on. Play in Chrome or Edge."
  });
  Object.assign(messages.ru, {
    'warning.mkvCodec': "MKV переносится в MP4 без перекодирования видео. HEVC/H.265, особенно 10-битное видео, может не воспроизводиться в Chrome или Edge. Надёжнее всего H.264.",
    'warning.longExport': "Длительность сцены — около {minutes} мин. Экспорт выполняется в памяти браузера и может потребовать несколько гигабайтов ОЗУ. Для надёжного экспорта разделите длинный эпизод или фильм на короткие сцены.",
    'upload.tooBigTunnel': "Файл весит {size} МБ, а через ссылку-туннель можно загрузить примерно до {max} МБ. Хост может загрузить его сам на своём компьютере, открыв http://localhost:3000 (.zip пака можно ещё положить в папку public/packs — он появится в библиотеке).",
    'upload.rejectedByTunnel': "Ссылка-туннель не пропустила файл: он слишком большой. Хост может загрузить его сам на своём компьютере через http://localhost:3000.",
    'upload.networkFailed': "Загрузка оборвалась (пропала связь или туннель). Попробуйте ещё раз; большие файлы лучше загружать хосту через http://localhost:3000.",
    'browser.useChrome': "Dubline лучше всего работает в Chrome или Edge. В этом браузере запись, экспорт или раздача видео могут работать неправильно.",
    'help.step1': "Если играть через колонки, звук видео попадёт в микрофон и в дубле будет эхо. Лучше проводные: Bluetooth-гарнитура при включённом микрофоне переходит в режим с плохим звуком. Играйте в Chrome или Edge."
  });
  Object.assign(messages.uk, {
    'warning.mkvCodec': "MKV переноситься в MP4 без перекодування відео. HEVC/H.265, особливо 10-бітне відео, може не відтворюватися в Chrome або Edge. Найнадійніший варіант — H.264.",
    'warning.longExport': "Тривалість сцени — близько {minutes} хв. Експорт виконується в пам’яті браузера й може потребувати кілька гігабайтів ОЗП. Для надійного експорту розділіть довгий епізод або фільм на коротші сцени.",
    'upload.tooBigTunnel': "Файл важить {size} МБ, а через посилання-тунель можна завантажити приблизно до {max} МБ. Хост може завантажити його сам на своєму комп’ютері, відкривши http://localhost:3000 (.zip пака можна ще покласти в теку public/packs — він з’явиться в бібліотеці).",
    'upload.rejectedByTunnel': "Посилання-тунель не пропустило файл: він завеликий. Хост може завантажити його сам на своєму комп’ютері через http://localhost:3000.",
    'upload.networkFailed': "Завантаження обірвалося (зник зв’язок або тунель). Спробуйте ще раз; великі файли краще завантажувати хосту через http://localhost:3000.",
    'browser.useChrome': "Dubline найкраще працює в Chrome або Edge. У цьому браузері запис, експорт або роздача відео можуть працювати неправильно.",
    'help.step1': "Якщо грати через колонки, звук відео потрапить у мікрофон і в дублі буде луна. Краще дротові: Bluetooth-гарнітура з увімкненим мікрофоном переходить у режим з поганим звуком. Грайте в Chrome або Edge."
  });

  // Server errors: the server sends a key, the English text is only a fallback
  Object.assign(messages.en, {
    'error.internal': "Internal server error. Details are in the host's server window.",
    'error.fileTooBig': "The file is too large (max {max} MB).",
    'error.uploadFailed': "Upload failed: {message}",
    'error.hostOnlyPack': "Only the room host can change the pack.",
    'error.hostOnlyScene': "Only the room host can create a scene.",
    'error.noFile': "No file was sent.",
    'error.needZip': "A .zip archive is required.",
    'error.notZip': "The file does not look like a .zip archive.",
    'error.packTooBig': "The unpacked pack is larger than {max} MB.",
    'error.badPackName': "Invalid mod name.",
    'error.packNotFound': "The mod was not found on the server.",
    'error.noVideo': "No video file was sent (.mp4 / .mkv).",
    'error.videoFormat': "Only .mp4 and .mkv videos are supported.",
    'error.subtitleFormat': "Supported subtitles: .ass, .ssa, .srt and .vtt.",
    'error.subtitlesTooBig': "The subtitles are larger than {max} MB.",
    'error.noEmbeddedSubtitles': "The MKV has no embedded ASS/SSA/SRT subtitles.",
    'error.needSubtitles': "Add a subtitle file or use an MKV with an embedded subtitle track.",
    'error.noSubtitleLines': "No lines were found in the subtitle file.",
    'error.processingFailed': "Could not process the video. Details are in the host's server window.",
    'error.processingTimeout': "Processing the video took too long and was stopped.",
    'error.badRequest': "Invalid request.",
    'error.nickNotConfirmed': "Your nickname is not confirmed. Rejoin the room.",
    'error.sessionDeleted': "The session this take was recorded in has been deleted.",
    'error.lineNotFound': "Line not found.",
    'error.lineTaken': "The line is claimed by another player.",
    'error.notYourTake': "You cannot delete someone else's take."
  });
  Object.assign(messages.ru, {
    'error.internal': "Внутренняя ошибка сервера. Подробности — в окне сервера у хоста.",
    'error.fileTooBig': "Файл слишком большой (максимум {max} МБ).",
    'error.uploadFailed': "Ошибка загрузки: {message}",
    'error.hostOnlyPack': "Менять пак может только хост комнаты.",
    'error.hostOnlyScene': "Создавать сцену может только хост комнаты.",
    'error.noFile': "Файл не передан.",
    'error.needZip': "Нужен .zip архив.",
    'error.notZip': "Файл не похож на .zip архив.",
    'error.packTooBig': "Распакованный пак больше {max} МБ.",
    'error.badPackName': "Некорректное имя мода.",
    'error.packNotFound': "Мод не найден на сервере.",
    'error.noVideo': "Не передан видеофайл (.mp4 / .mkv).",
    'error.videoFormat': "Поддерживаются только видео .mp4 и .mkv.",
    'error.subtitleFormat': "Поддерживаются субтитры .ass, .ssa, .srt и .vtt.",
    'error.subtitlesTooBig': "Субтитры больше {max} МБ.",
    'error.noEmbeddedSubtitles': "В MKV нет встроенных субтитров ASS/SSA/SRT.",
    'error.needSubtitles': "Добавьте файл субтитров или MKV со встроенной дорожкой субтитров.",
    'error.noSubtitleLines': "В файле субтитров не найдено реплик.",
    'error.processingFailed': "Не удалось обработать видео. Подробности — в окне сервера у хоста.",
    'error.processingTimeout': "Обработка видео заняла слишком много времени и была остановлена.",
    'error.badRequest': "Некорректные данные.",
    'error.nickNotConfirmed': "Ник не подтвержден — перезайдите в комнату.",
    'error.sessionDeleted': "Сессия, в которой записан дубль, уже удалена.",
    'error.lineNotFound': "Реплика не найдена.",
    'error.lineTaken': "Реплика занята другим игроком.",
    'error.notYourTake': "Нельзя удалить чужой дубль."
  });
  Object.assign(messages.uk, {
    'error.internal': "Внутрішня помилка сервера. Подробиці — у вікні сервера в хоста.",
    'error.fileTooBig': "Файл завеликий (максимум {max} МБ).",
    'error.uploadFailed': "Помилка завантаження: {message}",
    'error.hostOnlyPack': "Змінювати пак може лише хост кімнати.",
    'error.hostOnlyScene': "Створювати сцену може лише хост кімнати.",
    'error.noFile': "Файл не передано.",
    'error.needZip': "Потрібен .zip архів.",
    'error.notZip': "Файл не схожий на .zip архів.",
    'error.packTooBig': "Розпакований пак більший за {max} МБ.",
    'error.badPackName': "Некоректна назва мода.",
    'error.packNotFound': "Мод не знайдено на сервері.",
    'error.noVideo': "Не передано відеофайл (.mp4 / .mkv).",
    'error.videoFormat': "Підтримуються лише відео .mp4 і .mkv.",
    'error.subtitleFormat': "Підтримуються субтитри .ass, .ssa, .srt і .vtt.",
    'error.subtitlesTooBig': "Субтитри більші за {max} МБ.",
    'error.noEmbeddedSubtitles': "У MKV немає вбудованих субтитрів ASS/SSA/SRT.",
    'error.needSubtitles': "Додайте файл субтитрів або MKV з вбудованою доріжкою субтитрів.",
    'error.noSubtitleLines': "У файлі субтитрів не знайдено реплік.",
    'error.processingFailed': "Не вдалося обробити відео. Подробиці — у вікні сервера в хоста.",
    'error.processingTimeout': "Обробка відео тривала занадто довго й була зупинена.",
    'error.badRequest': "Некоректні дані.",
    'error.nickNotConfirmed': "Нік не підтверджено — перезайдіть у кімнату.",
    'error.sessionDeleted': "Сесію, в якій записано дубль, уже видалено.",
    'error.lineNotFound': "Репліку не знайдено.",
    'error.lineTaken': "Репліку зайняв інший гравець.",
    'error.notYourTake': "Не можна видалити чужий дубль."
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

  // Language code of an audio track (jpn, rus, en…) as a name in the interface language
  function languageName(code) {
    if (!code || code === 'und') return '';
    try {
      const name = new Intl.DisplayNames([language], { type: 'language' }).of(code);
      return name.charAt(0).toUpperCase() + name.slice(1);
    } catch (e) {
      return code;
    }
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

  window.DublineI18n = { t, apply, setLanguage, getLanguage: () => language, languageName, messages };
})();
