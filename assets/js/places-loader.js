(function() {
  var key = '__GOOGLE_PLACES_API_KEY__';
  // Only load SDK if key is real (local dev) OR we are on local file
  if (key && key !== '__GOOGLE_PLACES_API_KEY__') {
    var s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + key + '&libraries=places&callback=initAutocomplete';
    s.async = true; s.defer = true;
    document.head.appendChild(s);
  }
})();
