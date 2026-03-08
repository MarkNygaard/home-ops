# Media Stack Configuration

All media apps share a 200Gi PVC mounted at `/media` on k8s-0. Directory structure:

```
/media/
  movies/      # Radarr library
  tv/          # Sonarr library
  downloads/   # qBittorrent downloads
```

Because all paths are on the same mount (`/media`), hardlinks work for instant moves from downloads to library folders.

## Access URLs

| App         | URL                             |
| ----------- | ------------------------------- |
| qBittorrent | https://qbittorrent.mnygaard.io |
| Prowlarr    | https://prowlarr.mnygaard.io    |
| Radarr      | https://radarr.mnygaard.io      |
| Sonarr      | https://sonarr.mnygaard.io      |
| Bazarr      | https://bazarr.mnygaard.io      |
| Jellyfin    | https://jellyfin.mnygaard.io    |
| Seerr       | https://seerr.mnygaard.io       |

## Internal service DNS (for inter-app communication)

| App         | Internal URL                                      |
| ----------- | ------------------------------------------------- |
| qBittorrent | `http://qbittorrent.media.svc.cluster.local:8080` |
| Prowlarr    | `http://prowlarr.media.svc.cluster.local:80`      |
| Radarr      | `http://radarr.media.svc.cluster.local:80`        |
| Sonarr      | `http://sonarr.media.svc.cluster.local:80`        |
| Bazarr      | `http://bazarr.media.svc.cluster.local:6767`      |
| Jellyfin    | `http://jellyfin.media.svc.cluster.local:8096`    |

## qBittorrent

1. Check pod logs for the temporary admin password:
    ```
    kubectl logs -n media deploy/qbittorrent -c app
    ```
2. Log in at https://qbittorrent.mnygaard.io with `admin` and the temporary password
3. Go to `Tools > Options > WebUI` and change the password, then save
4. In the left panel, right-click Categories > Add Category:
    - `movies` with Save Path: `movies`
    - `tv` with Save Path: `tv`
5. Go to `Tools > Options > Downloads > Saving Management`:
    - Default Torrent Management Mode: **Automatic**
    - When Torrent Category changed: **Relocate torrent**
    - When Default Save Path Changed: **Switch affected torrents to Manual Mode**
    - When Category Save Path Changed: **Switch affected torrents to Manual Mode**
    - Tick both **Use Subcategories** and **Use Category paths in Manual Mode**
    - Default Save Path: `/media/downloads`
    - Save

Reference: [Trash Guides - qBittorrent categories](https://trash-guides.info/Downloaders/qBittorrent/How-to-add-categories/)

## Prowlarr

1. Go to https://prowlarr.mnygaard.io
2. `Settings > Download Clients` > `+` > qBittorrent:
    - Host: `qbittorrent.media.svc.cluster.local`
    - Port: `8080`
    - Untick **Use SSL**
    - Username/password: your qBittorrent credentials
    - Test and Save

## Radarr

1. Go to https://radarr.mnygaard.io
2. `Settings > Media Management`:
    - Add Root Folder: `/media/movies`
    - Show Advanced > Importing: tick **Use Hardlinks instead of Copy**
    - Optional: tick Rename Movies, Delete empty movie folders, Import Extra Files (`srt,sub,nfo`)
3. `Settings > Download Clients` > `+` > qBittorrent:
    - Host: `qbittorrent.media.svc.cluster.local`
    - Port: `8080`
    - Untick **Use SSL**
    - Username/password: your qBittorrent credentials
    - Category: `movies`
    - Test and Save
4. Connect to Prowlarr:
    - Copy API key from `Settings > General`
    - In Prowlarr: `Settings > Apps` > `+` > Radarr
    - Paste API key
    - Prowlarr Server: `http://prowlarr.media.svc.cluster.local:80`
    - Radarr Server: `http://radarr.media.svc.cluster.local:80`
    - Test and Save

## Sonarr

1. Go to https://sonarr.mnygaard.io
2. `Settings > Media Management`:
    - Add Root Folder: `/media/tv`
    - Show Advanced > Importing: tick **Use Hardlinks instead of Copy**
    - Optional: tick Rename Episodes, Delete empty folders, Import Extra Files (`srt,sub,nfo`)
3. `Settings > Download Clients` > `+` > qBittorrent:
    - Host: `qbittorrent.media.svc.cluster.local`
    - Port: `8080`
    - Untick **Use SSL**
    - Username/password: your qBittorrent credentials
    - Category: `tv`
    - Test and Save
4. Connect to Prowlarr:
    - Copy API key from `Settings > General`
    - In Prowlarr: `Settings > Apps` > `+` > Sonarr
    - Paste API key
    - Prowlarr Server: `http://prowlarr.media.svc.cluster.local:80`
    - Sonarr Server: `http://sonarr.media.svc.cluster.local:80`
    - Test and Save

## Bazarr

1. Go to https://bazarr.mnygaard.io
2. `Settings > Languages`: create a Language Profile (e.g. "English")
3. `Settings > Providers`: add subtitle sources (OpenSubtitles, Embedded Subtitles, Subdl, TVSubtitles, YIFY Subtitles, Wizdom, etc.)
4. After Radarr/Sonarr are connected, go to Movies/Series tab and click Update to pull in your library

## Jellyfin

1. Go to https://jellyfin.mnygaard.io
2. Add Media Library:
    - Content Type: **Movies**, folder: `/media/movies`
    - Content Type: **Shows**, folder: `/media/tv`
3. Install plugins:
    - Intro Skipper (https://intro-skipper.org/manifest.json)
    - Editor's Choice (https://github.com/lachlandcp/jellyfin-editors-choice-plugin/raw/main/manifest.json)
    - File Transformations (https://www.iamparadox.dev/jellyfin/plugins/manifest.json)
