require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const multer = require("multer");
const XLSX = require("xlsx");
const unzipper = require("unzipper");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

/* ================= DATABASE CONNECTION ================= */

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});
// const db = mysql.createPool({
//   host: process.env.DB_HOST,
//   user: process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
//   database: process.env.DB_NAME,
//   port: process.env.DB_PORT,
//   timezone: "+05:30",   
//   ssl: {
//     rejectUnauthorized: false
//   }
// });

db.getConnection((err, connection) => {
  if (err) console.error("Database connection failed:", err);
  else {
    console.log("MySQL Connected");
    connection.release();
  }
});

/* ================= LOGIN API ================= */

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;

  db.query(
    "SELECT * FROM users WHERE email = ? AND is_active = TRUE",
    [email],
    (err, results) => {

      if (err) return res.status(500).json({ message: "Database error" });
      if (!results.length)
        return res.status(401).json({ message: "Invalid credentials" });

      const user = results[0];

      if (password !== user.password)
        return res.status(401).json({ message: "Invalid credentials" });

      const token = jwt.sign(
        {
          id: user.user_id,
          role: user.role,
          center_code: user.center_code || null
        },
        process.env.JWT_SECRET,
        { expiresIn: "8h" }
      );

      res.json({
        message: "Login successful",
        token,
        role: user.role
      });
    }
  );
});

/* ================= VERIFY TOKEN ================= */

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ message: "Access denied" });

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
};
function findFileRecursive(dir, fileName) {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const fullPath = path.join(dir, file);

    if (fs.statSync(fullPath).isDirectory()) {
      const found = findFileRecursive(fullPath, fileName);
      if (found) return found;
    } else {
      if (file.trim().toLowerCase() === fileName.trim().toLowerCase()) {
        return fullPath;
      }
    }
  }

  return null;
}

function excelDateToMySQL(value) {
  if (!value) return null;

  // If Excel numeric date
  if (typeof value === "number") {
    const jsDate = new Date((value - 25569) * 86400 * 1000);
    return jsDate.toISOString().slice(0, 19).replace("T", " ");
  }

  // If already string date
  return new Date(value).toISOString().slice(0, 19).replace("T", " ");
}
/* ================= BULK UPLOAD ================= */

app.post(
  "/api/papers/bulk-upload",
  verifyToken,
  upload.fields([
    { name: "excel", maxCount: 1 },
    { name: "zip", maxCount: 1 }
  ]),
  async (req, res) => {

    if (req.user.role !== "controller")
      return res.status(403).json({ message: "Access denied" });

    const promiseDB = db.promise();
    const connection = await promiseDB.getConnection();

    try {

      if (!req.files?.excel || !req.files?.zip)
        return res.status(400).json({ message: "Excel and ZIP required" });

      const excelFile = req.files["excel"][0];
      const zipFile = req.files["zip"][0];

      // ===== Create folders =====
      const tempDir = path.join(__dirname, "temp");
      const uploadDir = path.join(__dirname, "uploads");

      if (!fs.existsSync(tempDir))
        fs.mkdirSync(tempDir);

      if (!fs.existsSync(uploadDir))
        fs.mkdirSync(uploadDir);

      const extractPath = path.join(tempDir, Date.now().toString());
      fs.mkdirSync(extractPath);

      // ===== Extract ZIP =====
      await unzipper.Open.buffer(zipFile.buffer)
        .then(d => d.extract({ path: extractPath }));

      console.log("ZIP Extracted to:", extractPath);

      // ===== Read Excel =====
      const workbook = XLSX.read(excelFile.buffer);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);

      if (!rows.length)
        return res.status(400).json({ message: "Excel empty" });

      let success = 0;
      let failed = 0;

      await connection.beginTransaction();

      let successSubjects = [];
      let failedSubjects = [];

      for (const row of rows) {

        const {
          subject_code,
          subject_name,
          course_name,
          department_name,
          semester_number,
          exam_date,
          session,
          exam_time,
          release_time,
          expiry_time,
          center_codes,
          pdf_file_name
        } = row;

        try {

          if (!subject_code || !subject_name)
            throw new Error("Missing subject_code or subject_name");

          // ===== Check Duplicate Question Paper =====
          const [paperCheck] = await connection.query(
            "SELECT subject_code FROM question_papers WHERE subject_code = ?",
            [subject_code]
          );

          if (paperCheck.length)
            throw new Error("Duplicate subject_code already exists");

          // ===== Insert Subject If Not Exists =====
          const [subjectCheck] = await connection.query(
            "SELECT subject_code FROM subjects WHERE subject_code = ?",
            [subject_code]
          );

          if (!subjectCheck.length) {

            await connection.query(
              `INSERT INTO subjects
         (subject_code, subject_name, course_name, department_name, semester_number)
         VALUES (?, ?, ?, ?, ?)`,
              [
                subject_code,
                subject_name,
                course_name,
                department_name,
                semester_number
              ]
            );
          }

          // ===== Date Conversion =====
          const formattedExamDate = excelDateToMySQL(exam_date)?.slice(0, 10);
          const formattedReleaseTime = excelDateToMySQL(release_time);
          const formattedExpiryTime = excelDateToMySQL(expiry_time);

          if (!formattedReleaseTime || !formattedExpiryTime)
            throw new Error("Invalid release_time or expiry_time");

          // ===== Validate Centers =====
          const centers = center_codes?.split(",") || [];

          for (const code of centers) {
            const [centerCheck] = await connection.query(
              "SELECT center_code FROM exam_centers WHERE center_code = ?",
              [code.trim()]
            );

            if (!centerCheck.length)
              throw new Error(`Center not found: ${code.trim()}`);
          }

          // ===== Find PDF =====
          const pdfPath = findFileRecursive(extractPath, pdf_file_name);

          if (!pdfPath)
            throw new Error(`PDF not found: ${pdf_file_name}`);

          const finalPath = path.join(uploadDir, pdf_file_name);
          fs.copyFileSync(pdfPath, finalPath);

          // ===== Insert Question Paper =====
          await connection.query(
            `INSERT INTO question_papers
       (subject_code, exam_date, session, exam_time,
        release_time, expiry_time, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              subject_code,
              formattedExamDate,
              session,
              exam_time,
              formattedReleaseTime,
              formattedExpiryTime,
              pdf_file_name
            ]
          );

          // ===== Insert Center Mapping =====
          for (const code of centers) {
            await connection.query(
              `INSERT INTO paper_center_map
         (subject_code, center_code)
         VALUES (?, ?)`,
              [subject_code, code.trim()]
            );
          }

          successSubjects.push({
            subject_code,
            subject_name
          });

        } catch (err) {

          failedSubjects.push({
            subject_code: subject_code || "UNKNOWN",
            subject_name: subject_name || "UNKNOWN",
            reason: err.message
          });

        }
      }

      await connection.commit();
      connection.release();
      res.json({
        message: "Bulk upload completed",
        total: rows.length,
        successCount: successSubjects.length,
        failedCount: failedSubjects.length,
        successSubjects,
        failedSubjects
      });

    } catch (error) {

      await connection.rollback();
      connection.release();

      console.error("Bulk upload error:", error);
      res.status(500).json({ message: "Bulk upload failed" });
    }
  }
);
// ================= RELEASE PAPER (Controller Only) =================

app.patch("/api/papers/release/:subject_code", verifyToken, async (req, res) => {

  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  const { subject_code } = req.params;

  try {

    const promiseDB = db.promise();

    // Check if paper exists
    const [rows] = await promiseDB.query(
      "SELECT subject_code FROM question_papers WHERE subject_code = ?",
      [subject_code]
    );

    if (!rows.length)
      return res.status(404).json({ message: "Paper not found" });

    // Update release
    await promiseDB.query(
      `UPDATE question_papers 
       SET is_released = TRUE,
           release_time = NOW()
       WHERE subject_code = ?`,
      [subject_code]
    );

    res.json({
      message: "Paper released successfully",
      subject_code
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Release failed" });
  }

});
// ================= CLOSE PAPER =================

app.patch("/api/papers/close/:subject_code", verifyToken, async (req, res) => {

  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  const { subject_code } = req.params;

  try {

    const promiseDB = db.promise();

    await promiseDB.query(
      `UPDATE question_papers 
       SET expiry_time = NOW()
       WHERE subject_code = ?`,
      [subject_code]
    );

    res.json({ message: "Paper closed successfully" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Close failed" });
  }

});

app.get(
  "/api/papers/download/:code",
  verifyToken,
  async (req, res) => {

    const [rows] = await db.promise().query(
      "SELECT file_path FROM question_papers WHERE subject_code = ?",
      [req.params.code]
    );

    if (!rows.length)
      return res.status(404).json({ message: "Paper not found" });

    const filePath = path.join(__dirname, "uploads", rows[0].file_path);

    if (!fs.existsSync(filePath))
      return res.status(404).json({ message: "File missing" });

    res.download(filePath);
  }
);
// review ,delete,release, close

// Get all papers
// ================= GET ALL PAPERS (With Subject Details) =================
// ================= ENTERPRISE PAPERS LIST =================
app.get("/api/papers", verifyToken, async (req, res) => {

  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  try {

    const [rows] = await db.promise().query(`
      SELECT 
        qp.subject_code,
        s.subject_name,
        s.course_name,
        s.department_name,
        s.semester_number,

        qp.exam_date,
        qp.session,
        qp.exam_time,
        qp.release_time,
        qp.expiry_time,
        qp.is_released,
        qp.file_path,

        GROUP_CONCAT(ec.center_code) AS center_codes,
        GROUP_CONCAT(ec.center_name) AS center_names

      FROM question_papers qp

      JOIN subjects s 
        ON qp.subject_code = s.subject_code

      LEFT JOIN paper_center_map pcm
        ON qp.subject_code = pcm.subject_code

      LEFT JOIN exam_centers ec
        ON pcm.center_code = ec.center_code

      GROUP BY qp.subject_code

      ORDER BY qp.exam_date DESC
    `);

    res.json(rows);

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch papers" });
  }

});

// Delete paper
app.delete("/api/papers/:subject_code", verifyToken, async (req, res) => {
  await db.promise().query(
    "DELETE FROM question_papers WHERE subject_code = ?",
    [req.params.subject_code]
  );
  res.json({ message: "Paper deleted" });
});


// exam centers code


app.get("/api/centers", verifyToken, async (req, res) => {
  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  const [rows] = await db.promise().query(
    "SELECT * FROM exam_centers ORDER BY created_at DESC"
  );

  res.json(rows);
});

app.post("/api/centers", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "controller")
      return res.status(403).json({ message: "Access denied" });

    const { center_code, center_name, email } = req.body;

    if (!center_code || !center_name)
      return res.status(400).json({ message: "Required fields missing" });

    await db.promise().query(
      `INSERT INTO exam_centers
       (center_code, center_name, email)
       VALUES (?, ?, ?)`,
      [center_code, center_name, email || null]
    );

    res.json({ message: "Center added successfully" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to add center" });
  }
});
app.put("/api/centers/:code", verifyToken, async (req, res) => {

  const { center_name, email, is_active } = req.body;

  await db.promise().query(
    `UPDATE exam_centers
     SET center_name = ?, email = ?, is_active = ?
     WHERE center_code = ?`,
    [center_name, email, is_active, req.params.code]
  );

  res.json({ message: "Center updated" });
});

app.delete("/api/centers/:code", verifyToken, async (req, res) => {

  await db.promise().query(
    "DELETE FROM exam_centers WHERE center_code = ?",
    [req.params.code]
  );

  res.json({ message: "Center deleted" });
});


// subject to center to question paper maping
app.get("/api/papers", verifyToken, async (req, res) => {
  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  const [rows] = await db.promise().query(`
    SELECT 
      qp.subject_code,
      s.subject_name,
      s.course_name,
      s.department_name,
      s.semester_number,
      qp.exam_date,
      qp.session,
      qp.exam_time,
      qp.release_time,
      qp.expiry_time,
      qp.is_released,
      GROUP_CONCAT(pcm.center_code) AS centers
    FROM question_papers qp
    JOIN subjects s ON qp.subject_code = s.subject_code
    LEFT JOIN paper_center_map pcm 
      ON qp.subject_code = pcm.subject_code
    GROUP BY qp.subject_code
    ORDER BY qp.exam_date DESC
  `);

  res.json(rows);
});
app.delete("/api/papers/:subject_code", verifyToken, async (req, res) => {
  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  await db.promise().query(
    "DELETE FROM question_papers WHERE subject_code = ?",
    [req.params.subject_code]
  );

  res.json({ message: "Paper deleted successfully" });
});
app.put("/api/papers/:subject_code", verifyToken, async (req, res) => {

  const {
    exam_date,
    session,
    exam_time,
    release_time,
    expiry_time,
    center_codes
  } = req.body;

  const connection = await db.promise().getConnection();

  try {
    await connection.beginTransaction();

    await connection.query(
      `UPDATE question_papers
       SET exam_date = ?, session = ?, exam_time = ?,
           release_time = ?, expiry_time = ?
       WHERE subject_code = ?`,
      [
        exam_date,
        session,
        exam_time,
        release_time,
        expiry_time,
        req.params.subject_code
      ]
    );

    await connection.query(
      "DELETE FROM paper_center_map WHERE subject_code = ?",
      [req.params.subject_code]
    );

    const centers = center_codes.split(",");

    for (const code of centers) {
      await connection.query(
        `INSERT INTO paper_center_map (subject_code, center_code)
         VALUES (?, ?)`,
        [req.params.subject_code, code.trim()]
      );
    }

    await connection.commit();
    connection.release();

    res.json({ message: "Paper updated successfully" });

  } catch (err) {
    await connection.rollback();
    connection.release();
    res.status(500).json({ message: "Update failed" });
  }
});
// subject to center to question paper maping
app.get("/api/papers", verifyToken, async (req, res) => {
  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  const [rows] = await db.promise().query(`
    SELECT 
      qp.subject_code,
      s.subject_name,
      s.course_name,
      s.department_name,
      s.semester_number,
      qp.exam_date,
      qp.session,
      qp.exam_time,
      qp.release_time,
      qp.expiry_time,
      qp.is_released,
      GROUP_CONCAT(pcm.center_code) AS centers
    FROM question_papers qp
    JOIN subjects s ON qp.subject_code = s.subject_code
    LEFT JOIN paper_center_map pcm 
      ON qp.subject_code = pcm.subject_code
    GROUP BY qp.subject_code
    ORDER BY qp.exam_date DESC
  `);

  res.json(rows);
});
app.delete("/api/papers/:subject_code", verifyToken, async (req, res) => {
  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  await db.promise().query(
    "DELETE FROM question_papers WHERE subject_code = ?",
    [req.params.subject_code]
  );

  res.json({ message: "Paper deleted successfully" });
});
app.put("/api/papers/:subject_code", verifyToken, async (req, res) => {

  const {
    exam_date,
    session,
    exam_time,
    release_time,
    expiry_time,
    center_codes
  } = req.body;

  const connection = await db.promise().getConnection();

  try {
    await connection.beginTransaction();

    await connection.query(
      `UPDATE question_papers
       SET exam_date = ?, session = ?, exam_time = ?,
           release_time = ?, expiry_time = ?
       WHERE subject_code = ?`,
      [
        exam_date,
        session,
        exam_time,
        release_time,
        expiry_time,
        req.params.subject_code
      ]
    );

    await connection.query(
      "DELETE FROM paper_center_map WHERE subject_code = ?",
      [req.params.subject_code]
    );

    const centers = center_codes.split(",");

    for (const code of centers) {
      await connection.query(
        `INSERT INTO paper_center_map (subject_code, center_code)
         VALUES (?, ?)`,
        [req.params.subject_code, code.trim()]
      );
    }

    await connection.commit();
    connection.release();

    res.json({ message: "Paper updated successfully" });

  } catch (err) {
    await connection.rollback();
    connection.release();
    res.status(500).json({ message: "Update failed" });
  }
});
app.get("/api/centers/list", verifyToken, async (req, res) => {
  const [rows] = await db.promise().query(
    "SELECT center_code, center_name FROM exam_centers WHERE is_active = TRUE"
  );
  res.json(rows);
});
app.patch(
  "/api/papers/toggle/:code",
  verifyToken,
  async (req, res) => {

    if (req.user.role !== "controller")
      return res.status(403).json({ message: "Access denied" });

    const [rows] = await db.promise().query(
      "SELECT is_released FROM question_papers WHERE subject_code = ?",
      [req.params.code]
    );

    if (!rows.length)
      return res.status(404).json({ message: "Paper not found" });

    const newStatus = !rows[0].is_released;

    await db.promise().query(
      "UPDATE question_papers SET is_released = ? WHERE subject_code = ?",
      [newStatus, req.params.code]
    );

    res.json({
      message: newStatus ? "Paper Released" : "Paper Closed",
      is_released: newStatus
    });
  }
);


// app.get("/api/papers/download/:subject_code", verifyToken, async (req, res) => {

//   const [rows] = await db.promise().query(
//     "SELECT file_path FROM question_papers WHERE subject_code = ?",
//     [req.params.subject_code]
//   );

//   if (!rows.length)
//     return res.status(404).json({ message: "File not found" });

//   const filePath = path.join(__dirname, "uploads", rows[0].file_path);

//   res.download(filePath);
// });
/* ========
========= PRINCIPAL VIEW PAPERS ================= */


const { PDFDocument, rgb, degrees } = require("pdf-lib");

app.get(
  "/api/principal/download/:subject_code",
  verifyToken,
  async (req, res) => {

    if (req.user.role !== "principal")
      return res.status(403).json({ message: "Access denied" });

    const subjectCode = req.params.subject_code;
    const centerCode = req.user.center_code;

    try {

      // ===== Check Paper =====
      const [paperRows] = await db.promise().query(
        "SELECT * FROM question_papers WHERE subject_code = ?",
        [subjectCode]
      );

      if (!paperRows.length)
        return res.status(404).json({ message: "Paper not found" });

      const paper = paperRows[0];

      if (!paper.is_released)
        return res.status(403).json({ message: "Paper not released yet" });

      if (new Date() > new Date(paper.expiry_time))
        return res.status(403).json({ message: "Paper expired" });

      // ===== Check Center Mapping =====
      const [mapRows] = await db.promise().query(
        `SELECT * FROM paper_center_map
         WHERE subject_code = ? AND center_code = ?`,
        [subjectCode, centerCode]
      );

      if (!mapRows.length)
        return res.status(403).json({ message: "Not assigned to your center" });

      // ===== Load Original PDF =====
      const filePath = path.join(__dirname, "uploads", paper.file_path);

      if (!fs.existsSync(filePath))
        return res.status(404).json({ message: "File missing" });

      const existingPdfBytes = fs.readFileSync(filePath);

      const pdfDoc = await PDFDocument.load(existingPdfBytes);
      const pages = pdfDoc.getPages();

      // ===== Add Watermark To Each Page =====
      pages.forEach((page) => {

        const { width, height } = page.getSize();

        page.drawText(
          `CONFIDENTIAL - Center: ${centerCode}`,
          {
            x: width / 4,
            y: height / 2,
            size: 30,
            color: rgb(1, 0, 0),
            rotate: degrees(45),
            opacity: 0.3
          }
        );
      });

      const pdfBytes = await pdfDoc.save();

      // ===== Send Watermarked PDF =====
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=${subjectCode}_${centerCode}.pdf`
      );

      res.setHeader("Content-Type", "application/pdf");
      res.send(Buffer.from(pdfBytes));

    } catch (err) {
      console.log(err);
      res.status(500).json({ message: "Download failed" });
    }
  }
);
app.get("/api/principal/papers", verifyToken, async (req, res) => {

  if (req.user.role !== "principal")
    return res.status(403).json({ message: "Access denied" });

  const centerCode = req.user.center_code;

  const [rows] = await db.promise().query(`
    SELECT 
      qp.subject_code,
      s.subject_name,
      qp.exam_date,
      qp.session,
      qp.release_time,
      qp.expiry_time,
      qp.is_released
    FROM question_papers qp
    JOIN subjects s 
      ON qp.subject_code = s.subject_code
    JOIN paper_center_map pcm 
      ON qp.subject_code = pcm.subject_code
    WHERE pcm.center_code = ?
    ORDER BY qp.exam_date DESC
  `, [centerCode]);

  res.json(rows);
});
// Get subject with assigned centers
// ================= GET ALL SUBJECTS =================
app.get("/api/subjects", verifyToken, async (req, res) => {

  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  try {

    const [rows] = await db.promise().query(
      `SELECT 
        subject_code,
        subject_name,
        course_name,
        department_name,
        semester_number
       FROM subjects
       ORDER BY created_at DESC`
    );

    res.json(rows);

  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});
app.get("/api/subjects/:subject_code", verifyToken, async (req, res) => {

  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  const { subject_code } = req.params;

  try {

    const [subjectRows] = await db.promise().query(
      `SELECT s.*
       FROM subjects s
       WHERE s.subject_code = ?`,
      [subject_code]
    );

    if (!subjectRows.length)
      return res.status(404).json({ message: "Subject not found" });

    const [assignedCenters] = await db.promise().query(
      `SELECT ec.center_code, ec.center_name
       FROM paper_center_map pcm
       JOIN exam_centers ec ON pcm.center_code = ec.center_code
       WHERE pcm.subject_code = ?`,
      [subject_code]
    );

    const [allCenters] = await db.promise().query(
      `SELECT center_code, center_name
       FROM exam_centers
       WHERE is_active = TRUE`
    );

    res.json({
      subject: subjectRows[0],
      assignedCenters,
      allCenters
    });

  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});
// ================= UPDATE PAPER CENTERS =================
app.put("/api/papers/:subject_code/centers", verifyToken, async (req, res) => {

  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  const { subject_code } = req.params;
  const { center_codes } = req.body;

  if (!Array.isArray(center_codes))
    return res.status(400).json({ message: "center_codes must be array" });

  const connection = await db.promise().getConnection();

  try {

    await connection.beginTransaction();

    // 1️⃣ Delete old mappings
    await connection.query(
      "DELETE FROM paper_center_map WHERE subject_code = ?",
      [subject_code]
    );

    // 2️⃣ Insert new mappings
    for (const code of center_codes) {
      await connection.query(
        `INSERT INTO paper_center_map (subject_code, center_code)
         VALUES (?, ?)`,
        [subject_code, code]
      );
    }

    await connection.commit();
    connection.release();

    res.json({ message: "Centers updated successfully" });

  } catch (err) {

    await connection.rollback();
    connection.release();

    console.error(err);
    res.status(500).json({ message: "Center update failed" });
  }
});
app.put("/api/subjects/:subject_code/centers", verifyToken, async (req, res) => {

  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  const { subject_code } = req.params;
  const { center_codes } = req.body;

  const connection = await db.promise().getConnection();

  try {

    await connection.beginTransaction();

    // Delete old mappings
    await connection.query(
      "DELETE FROM paper_center_map WHERE subject_code = ?",
      [subject_code]
    );

    // Insert new mappings
    for (const code of center_codes) {
      await connection.query(
        `INSERT INTO paper_center_map (subject_code, center_code)
         VALUES (?, ?)`,
        [subject_code, code]
      );
    }

    await connection.commit();
    connection.release();

    res.json({ message: "Centers updated successfully" });

  } catch (err) {

    await connection.rollback();
    connection.release();
    res.status(500).json({ message: "Update failed" });
  }
});
// ================= DELETE USER =================
app.delete("/api/users/:id", verifyToken, async (req, res) => {

  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  try {

    await db.promise().query(
      "DELETE FROM users WHERE user_id = ?",
      [req.params.id]
    );

    res.json({ message: "User deleted successfully" });

  } catch (err) {
    res.status(500).json({ message: "Delete failed" });
  }

});
// ================= UPDATE USER =================
app.put("/api/users/:id", verifyToken, async (req, res) => {

  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  const { name, email, role, center_code, is_active } = req.body;

  try {

    await db.promise().query(
      `UPDATE users
       SET name = ?, email = ?, role = ?, center_code = ?, is_active = ?
       WHERE user_id = ?`,
      [name, email, role, center_code || null, is_active, req.params.id]
    );

    res.json({ message: "User updated successfully" });

  } catch (err) {
    res.status(500).json({ message: "Update failed" });
  }

});
// ================= ADD USER =================
app.post("/api/users", verifyToken, async (req, res) => {

  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  const { name, email, password, role, center_code } = req.body;

  try {

    await db.promise().query(
      `INSERT INTO users 
       (name, email, password, role, center_code)
       VALUES (?, ?, ?, ?, ?)`,
      [name, email, password, role, center_code || null]
    );

    res.json({ message: "User created successfully" });

  } catch (err) {
    res.status(500).json({ message: "User creation failed" });
  }

});
// ================= GET ALL USERS =================
app.get("/api/users", verifyToken, async (req, res) => {

  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  try {

    const [rows] = await db.promise().query(`
      SELECT 
        u.user_id,
        u.name,
        u.email,
        u.password,
        u.role,
        u.center_code,
        u.is_active,
        u.created_at,
        ec.center_name
      FROM users u
      LEFT JOIN exam_centers ec 
        ON u.center_code = ec.center_code
      ORDER BY u.created_at DESC
    `);

    res.json(rows);

  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }

});
app.put("/api/papers/schedule/:subject_code", verifyToken, async (req, res) => {

  if (req.user.role !== "controller")
    return res.status(403).json({ message: "Access denied" });

  const { subject_code } = req.params;
  const { exam_date, release_time, expiry_time } = req.body;

  try {

    await db.promise().query(
      `UPDATE question_papers
       SET exam_date = ?,
           release_time = ?,
           expiry_time = ?
       WHERE subject_code = ?`,
      [exam_date, release_time, expiry_time, subject_code]
    );

    res.json({ message: "Schedule updated successfully" });

  } catch (err) {
    res.status(500).json({ message: "Schedule update failed" });
  }

});
/* ================= START SERVER ================= */

app.listen(process.env.PORT || 5000, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
