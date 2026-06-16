const express = require("express");
const app = express();

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("服务启动成功:", PORT);
});