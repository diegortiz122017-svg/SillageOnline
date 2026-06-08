# Pendientes — Sillage Online

## Bugs

- [ ] **Imágenes de perfumes no cargan en el modal del carrito**
  - Los objetos guardados en `localStorage` no tienen el campo `photos`
  - `renderCart()` en `index.html:4660` cae siempre en el fallback del ícono SVG
  - Al recibir el catálogo fresco del servidor (`/api/catalogue`), solo se actualiza
    el array global `P` pero los objetos dentro del carrito nunca se reconcilian
  - **Fix:** al restaurar el carrito o al recibir datos frescos, reconciliar cada item
    buscando el producto por `id` en `P` para heredar el campo `photos`
  - Archivos clave: `index.html:4660`, `index.html:4234`, `index.html:2841`,
    `services/catalogue.js:41`

## Mejoras

## Ideas
