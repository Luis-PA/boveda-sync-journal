# Diario de sincronización (plugin de Obsidian)

Solo para iPhone e iPad. Guarda en `99 Sistema/sync-journal/<dispositivo>/` la versión base y tus
versiones de cada nota que editas. El servidor MCP del NAS los compara con su historial git para
detectar versiones perdidas o pisadas y fusionarlas (solo, o con Claude si hay solapes).

Instalación con BRAT: sube `manifest.json` y `main.js` a un repositorio público de GitHub,
crea una release con la etiqueta `1.0.0` y adjunta esos dos archivos. En Obsidian:
BRAT → Add beta plugin → `Luis-PA/boveda-sync-journal`.
