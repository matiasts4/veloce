use reqwest::Client;
use std::cmp::min;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use futures_util::StreamExt;

pub async fn download_file<F>(url: &str, path: &Path, on_progress: F) -> Result<(), String>
where
    F: Fn(u64, u64) + Send + 'static,
{
    let client = Client::new();
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to connect: {}", e))?;

    let total_size = res.content_length().unwrap_or(0);
    
    let mut file = File::create(path).map_err(|e| format!("Failed to create file: {}", e))?;
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| format!("Error while downloading chunk: {}", e))?;
        file.write_all(&chunk).map_err(|e| format!("Error while writing to file: {}", e))?;
        
        downloaded = min(downloaded + (chunk.len() as u64), total_size);
        on_progress(downloaded, total_size);
    }

    Ok(())
}
