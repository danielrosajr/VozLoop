# VozLoop — estúdio de bolso · MVP 1.0

Aplicativo web progressivo (PWA) para gravação de acapella em camadas e criação de loops. **100% gratuito, local, sem login e sem serviços externos.**

## Funcionalidades

- **Gravação livre:** grave uma camada e finalize ao tocar novamente no botão vermelho ou em Parar. Novas camadas são gravadas enquanto as anteriores são reproduzidas, sempre alinhadas ao início.
- **Loops:** ajuste BPM (40–240) e quantidade de compassos (1, 2, 4, 8 ou 16), e grave camadas de duração fixa. O loop termina automaticamente. Reprodução repetida sem limite; exportação com 1, 2, 4, 8 ou 16 voltas.
- **Metrônomo de entrada:** contagem antes do início (3 segundos no modo livre; 4 batidas no modo loop).
- **Mixer por camada:** volume entre 0% e 150%, silenciar, excluir, renomear e ajustar o alinhamento de -500 a +500 ms.
- **Projetos:** várias músicas, salvamento automático local em IndexedDB.
- **Exportação WAV:** mixagem de camadas via OfflineAudioContext, com ajuste automático de pico para evitar distorção digital na gravação exportada.
- **Backup/importação:** salva projeto editável e todos os WAV em um arquivo JSON; permite importar em outro navegador ou dispositivo.
- **PWA offline:** depois do primeiro acesso, a interface funciona sem internet; gravações continuam armazenadas localmente.

## Como publicar no GitHub Pages

1. Crie um repositório público no GitHub, por exemplo `vozloop`.
2. Envie **todos os arquivos desta pasta** para a raiz do repositório (`index.html`, `main.js`, `audio-engine.js`, etc.).
3. Vá em **Settings > Pages**, escolha **Deploy from a branch**, branch `main`, pasta `/ (root)` e salve.
4. Abra `https://SEU_USUARIO.github.io/vozloop/` em **HTTPS**, conceda acesso ao microfone quando gravar e, se quiser, use **Adicionar à tela inicial** no navegador.

Se preferir executar localmente no computador:

```bash
cd VozLoop
python3 -m http.server 8000
```

Depois abra `http://localhost:8000` no navegador. Não abra `index.html` diretamente via `file://`: por segurança, alguns navegadores bloqueiam o microfone e o AudioWorklet fora de HTTPS ou localhost.

## Instruções rápidas

1. Clique em **Criar nova música** e escolha **Gravação livre** ou **Loops**.
2. Para loops, configure o ritmo e número de compassos antes da primeira gravação; depois os controles ficam travados para preservar a sincronização.
3. Conecte fones (preferencialmente com fio ou baixa latência) para não regravar as camadas que já estão tocando.
4. Toque no botão vermelho e siga a contagem; grave quantas camadas desejar.
5. Ajuste volumes e sincronização. Se houver atraso, experimente deslocamentos de 10 em 10 ms na camada.
6. Exporte uma mixagem `.wav` ou crie um **Backup** `.json` se quiser continuar editando em outro aparelho.

## Limitações conhecidas do MVP

- Os projetos e gravações ficam no **armazenamento local do navegador**; podem ser apagados ao limpar dados. Faça backups `.json` com frequência. Não existe sincronização entre dispositivos.
- Não funciona como gravador em segundo plano: mantenha a tela ligada e o app em primeiro plano durante a gravação. Alguns navegadores móveis suspendem o áudio ao bloquear a tela ou trocar de aplicativo.
- O acesso ao microfone requer HTTPS ou localhost, permissão do usuário e navegador compatível. Safari no iOS e navegadores Android podem variar na precisão de captura. Use o ajuste manual de até ±500 ms.
- O app não grava diretamente MP3 nem adiciona efeitos (reverb, equalização, autotune). A exportação WAV é mono PCM 16-bit.
- Se AudioWorklet não estiver disponível, usa ScriptProcessor como fallback (menos preciso e pode ter mais atrasos em aparelhos antigos).
- O volume de reprodução durante a gravação depende do sistema: caso não use fones, o áudio reproduzido poderá vazar no microfone e causar eco.
- O modo loop fixa tempo em **4/4**, sem edição avançada de compassos, recorte de clipes ou monitoramento da própria voz.
- O limite prático de duração, quantidade de camadas e tamanho dos backups depende da memória/armazenamento do dispositivo. A exportação de mixagens é limitada a 30 min.

## Arquivos

| Arquivo | Uso |
| --- | --- |
| `index.html` | Interface e modais |
| `styles.css` | Estilos responsivos |
| `main.js` | Interface, projetos, mixer, IndexedDB, backup e exportação |
| `audio-engine.js` | Captura, sincronização, reprodução e renderização WAV |
| `recorder-worklet.js` | Captura de áudio amostra a amostra no thread de áudio |
| `manifest.webmanifest`, `sw.js`, `icon*` | Instalação e funcionamento offline |

## Próximas melhorias possíveis

Editor visual da linha do tempo, loops em 3/4 e 6/8, regravação apenas de trechos, efeitos por canal, compressão/limiter na saída ao vivo, sincronização por nuvem e calibração de atraso automatizada.

**Privacidade:** este projeto não envia áudio pela internet, não coleta dados pessoais e não utiliza analytics. Tudo ocorre localmente.
