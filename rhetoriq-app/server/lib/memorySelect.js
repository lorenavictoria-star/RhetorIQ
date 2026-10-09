// Auswahl der Gedächtnis-Einträge nach Relevanz. Die Logik liegt in public/memorySelect.js, damit der Browser und der Server
// dieselbe Datei verwenden (der Browser stellt den Auftrag zusammen). Hier die Anbindung für Server und Tests.
module.exports = require('../../public/memorySelect.js');
