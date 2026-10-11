use room_engine::{field_engine::FieldEngine, rng::Rng};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut brain = FieldEngine::default();
    for t in 0..43_200_u32 {
        brain.step(
            &[f64::from(t % 100) / 100.0, 0.5, 0.0018, 3.4],
            1.0,
            120.0,
            1.0,
        )?;
    }
    let mut rng = Rng::new(12345);
    let random: Vec<_> = (0..64).map(|_| rng.next_u32()).collect();
    println!(
        "{}",
        serde_json::json!({ "field": brain.snapshot(), "tick": brain.tick(), "random": random })
    );
    Ok(())
}
