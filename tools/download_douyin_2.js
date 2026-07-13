var getid = async function (sec_user_id, max_cursor) {
  var res = await fetch(
    "https://www.douyin.com/aweme/v1/web/aweme/post/?device_platform=webapp&aid=6383&channel=channel_pc_web&sec_user_id=" +
      sec_user_id +
      "&max_cursor=" +
      max_cursor,
    {
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "vi",
        "sec-ch-ua":
          '"Not?A_Brand";v="8", "Chromium";v="108", "Microsoft Edge";v="108"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      referrer:
        "https://www.douyin.com/user/MS4wLjABAAAAl1WAod3vy6OAPHxyJPOJBwbHMBHluRC3okW8QkwoY5g",
      referrerPolicy: "strict-origin-when-cross-origin",
      body: null,
      method: "GET",
      mode: "cors",
      credentials: "include",
    },
  );
  try {
    res = await res.json();
  } catch (e) {
    res = await getid(sec_user_id, max_cursor);
    console.log(e);
  }
  return res;
};

var getBestVideoUrl = function (video) {
  if (Array.isArray(video.bit_rate) && video.bit_rate.length > 0) {
    var sorted = video.bit_rate.slice().sort(function (a, b) {
      return (b.height || 0) - (a.height || 0);
    });
    for (var br of sorted) {
      var url = br.play_addr && br.play_addr.url_list && br.play_addr.url_list[0];
      if (url) {
        if (!url.startsWith("https")) url = url.replace("http", "https");
        return url;
      }
    }
  }
  var fallbackUrl = video.play_addr && video.play_addr.url_list && video.play_addr.url_list[0];
  if (fallbackUrl) {
    if (!fallbackUrl.startsWith("https")) fallbackUrl = fallbackUrl.replace("http", "https");
    return fallbackUrl;
  }
  return null;
};

var createVideoFileName = function (desc, date, index) {
  var cleanTitle = desc
    .replace(/[^\w\s-]/gi, "")
    .replace(/[\s_-]+/g, "_")
    .substring(0, 50)
    .trim();
  var fileName =
    date + "_" + String(index).padStart(3, "0") + "_" + cleanTitle + ".mp4";
  return fileName;
};

var triggerDownload = function (url, fileName) {
  var a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

var createDownloaderUI = function () {
  var ui = document.createElement("div");
  ui.id = "douyinDownloader";
  ui.style.cssText = `
        position: fixed; top: 20px; right: 20px; z-index: 999999;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white; padding: 25px; border-radius: 15px;
        min-width: 320px; max-height: 90vh; overflow-y: auto;
        box-shadow: 0 10px 30px rgba(0,0,0,0.4);
        font-family: Arial, sans-serif; backdrop-filter: blur(10px);
        border: 2px solid rgba(255,255,255,0.2);
    `;

  ui.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h3 style="margin: 0; font-size: 18px;">🎬 Douyin Downloader</h3>
            <button id="closeBtn" style="
                background: rgba(255,255,255,0.2); color: white; border: none; 
                width: 30px; height: 30px; border-radius: 50%; cursor: pointer;
                font-size: 16px; display: flex; align-items: center; justify-content: center;
                transition: all 0.3s;
            ">✕</button>
        </div>
        
        <div style="background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; margin-bottom: 15px; font-size: 12px;">
            <strong>📝 HƯỚNG DẪN NHẬP:</strong><br>
            • <code>1</code> - Chọn video số 1<br>
            • <code>3-5</code> - Chọn video 3,4,5<br>
            • <code>1,10,15-20</code> - Chọn 1,10 và 15 đến 20<br>
            • Ưu tiên chất lượng cao nhất
        </div>
        
        <input type="text" id="videoNumbers" placeholder="VD: 1, 3-5, 10-20" 
            style="width: 100%; padding: 12px; border: none; border-radius: 8px; margin-bottom: 15px;
            font-size: 14px; box-sizing: border-box; background: rgba(255,255,255,0.9); color: #000;">
        <button id="downloadBtn" style="
            width: 100%; padding: 12px; background: #ff6b6b; color: white; 
            border: none; border-radius: 8px; font-size: 16px; font-weight: bold;
            cursor: pointer; transition: all 0.3s;
        ">🚀 DOWNLOAD</button>
        <div id="status" style="margin-top: 15px; font-size: 12px; text-align: center;"></div>
        <div id="progress" style="margin-top: 10px; font-size: 14px; font-weight: bold;"></div>
        <div id="downloadList" style="margin-top: 8px; max-height: 300px; overflow-y: auto;"></div>
    `;

  document.body.appendChild(ui);

  document.getElementById("closeBtn").onclick = function () {
    document.getElementById("douyinDownloader").remove();
    console.log("❌ Đã đóng Douyin Downloader");
  };

  return ui;
};

var parseVideoNumbers = function (input) {
  var numbers = [];
  var parts = input.split(",");

  for (var part of parts) {
    part = part.trim();
    if (part.includes("-")) {
      var range = part.split("-").map((n) => parseInt(n.trim()));
      for (var i = range[0]; i <= range[1]; i++) {
        numbers.push(i);
      }
    } else {
      var num = parseInt(part);
      if (!isNaN(num)) numbers.push(num);
    }
  }

  return numbers
    .filter((item, index, self) => self.indexOf(item) === index)
    .sort((a, b) => a - b);
};

var isDownloading = false;
var max_cursor = 0;

var runSingleDownload = async function () {
  if (isDownloading) {
    alert("⏳ Dang xu ly, vui long doi!");
    return;
  }

  var sec_user_id = location.pathname.replace("/user/", "");
  var result = [];
  var hasMore = 1;
  var targetNumbers = parseVideoNumbers(
    document.getElementById("videoNumbers").value,
  );
  var statusEl = document.getElementById("status");
  var progressEl = document.getElementById("progress");
  var listEl = document.getElementById("downloadList");
  var downloadBtn = document.getElementById("downloadBtn");

  if (targetNumbers.length === 0) {
    statusEl.innerHTML =
      "❌ Vui lòng nhập số hợp lệ!<br><small>VD: 1, 3-5, 10-20</small>";
    return;
  }

  isDownloading = true;
  downloadBtn.disabled = true;
  downloadBtn.innerHTML = "⏳ ĐANG LẤY DANH SÁCH...";
  statusEl.innerHTML = `📊 Dang lay danh sach cho ${targetNumbers.length} video...`;
  listEl.innerHTML = "";

  // Lấy toàn bộ danh sách video
  while (hasMore == 1) {
    try {
      var moredata = await getid(sec_user_id, max_cursor);
      hasMore = moredata["has_more"];
      max_cursor = moredata["max_cursor"];

      for (var i in moredata["aweme_list"]) {
        var video = moredata["aweme_list"][i];
        var videoUrl = getBestVideoUrl(video["video"]);

        var createTime = video["create_time"] * 1000;
        var date = new Date(createTime);
        var dateStr =
          date.getFullYear() +
          String(date.getMonth() + 1).padStart(2, "0") +
          String(date.getDate()).padStart(2, "0");

        result.push([videoUrl, video["aweme_id"], video["desc"], dateStr]);
      }

      statusEl.innerHTML = `📊 Loaded ${result.length} videos...`;
    } catch (e) {
      console.log("❌ Lỗi:", e);
      break;
    }
  }

  var totalVideos = result.length;
  var foundVideos = [];

  for (var num of targetNumbers) {
    if (num <= totalVideos && num > 0) {
      var videoInfo = result[num - 1];
      if (videoInfo[0]) {
        foundVideos.push({
          index: num,
          url: videoInfo[0],
          aweme_id: videoInfo[1],
          desc: videoInfo[2],
          date: videoInfo[3],
          file_name: createVideoFileName(videoInfo[2], videoInfo[3], num),
        });
      }
    }
  }

  if (foundVideos.length === 0) {
    statusEl.innerHTML = `❌ Không tìm thấy video nào!<br><small>Kênh chỉ có ${totalVideos} video</small>`;
    isDownloading = false;
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = "🚀 DOWNLOAD";
    return;
  }

  statusEl.innerHTML = `✅ ${foundVideos.length} video. Bat dau download...`;

  // Hien danh sach
  listEl.innerHTML = foundVideos.map(function (v) {
    return '<div style="padding:3px 0;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.1);">' +
      '<b>#' + v.index + '</b> ' +
      '<span style="opacity:0.7;">' + (v.desc || v.aweme_id).substring(0, 40) + '</span>' +
      ' <span id="dd_s_' + v.index + '" style="color:#ffd700;">⏳</span>' +
    '</div>';
  }).join("");

  // Download tung video
  for (var idx = 0; idx < foundVideos.length; idx++) {
    var item = foundVideos[idx];
    var statEl = document.getElementById("dd_s_" + item.index);
    progressEl.innerHTML = `⬇️ ${idx + 1}/${foundVideos.length}: #${item.index}`;

    triggerDownload(item.url, item.file_name);
    if (statEl) statEl.textContent = "✅";
    console.log("✅ #" + item.index + " " + item.file_name + " → " + item.url);

    if (idx < foundVideos.length - 1) {
      await new Promise(function (r) { setTimeout(r, 2000); });
    }
  }

  progressEl.innerHTML = "";
  statusEl.innerHTML = `🎉 Xong! Da trigger ${foundVideos.length} download.`;
  isDownloading = false;
  downloadBtn.disabled = false;
  downloadBtn.innerHTML = "🚀 DOWNLOAD";
};

var initDownloader = function () {
  if (document.getElementById("douyinDownloader")) return;

  var ui = createDownloaderUI();

  document.getElementById("downloadBtn").onclick = runSingleDownload;

  document
    .getElementById("videoNumbers")
    .addEventListener("keypress", function (e) {
      if (e.key === "Enter") {
        runSingleDownload();
      }
    });

  console.log("🎬 Douyin Downloader da san sang!");
};

initDownloader();
