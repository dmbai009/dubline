(() => {
  const select = document.getElementById('settingsVideoAcceleration');
  select.value = DublineVideoAcceleration.get();
  select.addEventListener('change', () => DublineVideoAcceleration.set(select.value));
  window.addEventListener('dubline-acceleration-changed', () => { select.value = DublineVideoAcceleration.get(); });
  window.addEventListener('storage', event => {
    if (event.key === 'dubline_video_acceleration') DublineVideoAcceleration.set(event.newValue);
  });
})();
