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

var translateText = async function (text) {
  try {
    var url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=vi&dt=t&q=" +
      encodeURIComponent(text);
    var response = await fetch(url);
    var data = await response.json();
    if (data && data[0] && data[0][0] && data[0][0][0]) {
      return data[0].map((item) => item[0]).join("");
    }
    return text;
  } catch (e) {
    console.log("❌ Lỗi khi dịch:", e);
    return text;
  }
};

var download = async function (url, aweme_id, desc, date, index) {
  var translatedDesc = await translateText(desc);
  var cleanTitle = translatedDesc.replace(/[\\/:*?"<>|]/g, "").trim();
  var file_name =
    date + "_" + String(index).padStart(3, "0") + "_" + cleanTitle + ".mp4";
  console.log(`   📝 Gốc: ${desc}`);
  console.log(`   ✅ Dịch: ${translatedDesc}`);
  var data = await fetch(url, {
    headers: {
      accept: "*/*",
      "accept-language": "vi,en-US;q=0.9,en;q=0.8",
      range: "bytes=0-",
      "sec-ch-ua":
        '"Not?A_Brand";v="8", "Chromium";v="108", "Microsoft Edge";v="108"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "video",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "cross-site",
    },
    referrer: "https://www.douyin.com/",
    referrerPolicy: "strict-origin-when-cross-origin",
    body: null,
    method: "GET",
    mode: "cors",
    credentials: "omit",
  });
  data = await data.blob();
  var a = document.createElement("a");
  a.href = window.URL.createObjectURL(data);
  a.download = file_name;
  a.click();
};

var waitforme = function (millisec) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve("");
    }, millisec);
  });
};

var run = async function () {
  var result = [];
  var hasMore = 1;
  var sec_user_id = location.pathname.replace("/user/", "");
  var max_cursor = 0;
  if (
    !confirm(
      "Tải toàn bộ video của kênh này?\n\n⚠️ CẢNH BÁO: Có thể rất nhiều video!\nThời gian tải sẽ lâu!\n\n✨ Tính năng: Tự động dịch title từ Tiếng Trung sang Tiếng Việt",
    )
  ) {
    return;
  }
  console.log("🔄 Bắt đầu lấy danh sách video...");
  while (hasMore == 1) {
    try {
      var moredata = await getid(sec_user_id, max_cursor);
      hasMore = moredata["has_more"];
      max_cursor = moredata["max_cursor"];
      for (var i in moredata["aweme_list"]) {
        var video = moredata["aweme_list"][i];
        var videoUrl = video["video"]["play_addr"]["url_list"][0];
        var createTime = video["create_time"] * 1000;
        var date = new Date(createTime);
        var dateStr =
          date.getFullYear() +
          String(date.getMonth() + 1).padStart(2, "0") +
          String(date.getDate()).padStart(2, "0");
        if (!videoUrl.startsWith("https")) {
          videoUrl = videoUrl.replace("http", "https");
        }
        result.push([videoUrl, video["aweme_id"], video["desc"], dateStr]);
      }
      console.clear();
      console.log("📊 Tổng Videos tìm thấy: " + result.length);
      console.log("⏳ Đang lấy thêm... (has_more: " + hasMore + ")");
    } catch (e) {
      console.log("❌ Lỗi khi lấy dữ liệu: ", e);
      break;
    }
  }
  console.clear();
  console.log("✅ Đã lấy xong danh sách: " + result.length + " video");
  console.log("🌐 Đang dịch và tải video...");
  for (var i = 0; i < result.length; i++) {
    try {
      await waitforme(2000);
      console.log(`⬇️ Đang xử lý ${i + 1}/${result.length}:`);
      await download(
        result[i][0],
        result[i][1],
        result[i][2],
        result[i][3],
        i + 1,
      );
    } catch (e) {
      console.log(`❌ Lỗi tải video ${i + 1}: ${e.message}`);
    }
  }
  console.log("🎉 Hoàn thành tải " + result.length + " video!");
  alert(
    "Tải xong " +
      result.length +
      " video!\nĐã tự động dịch title sang Tiếng Việt",
  );
};
run();
